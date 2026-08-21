import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { getLogger } from './logger'
import type { Database } from './database'
import type { OnlineSearchResult, TrackTagInput } from '@shared/types'

/** Download options for YouTube videos (merged audio). */
export interface YouTubeDownloadOptions {
  /** Max video height (0 = best available). */
  height?: number
  /** Audio stream preference: best / m4a / opus. */
  audio?: 'best' | 'm4a' | 'opus'
  /** Live progress callback: percent (0-100), bytes, totalBytes, speed (B/s), eta (s). */
  onProgress?: (p: number, bytes: number, total: number, speed: number, eta: number) => void
  /** Abort check (called between progress ticks); kills the child when true. */
  isAborted?: () => boolean
}

const MB_ENDPOINT = 'https://musicbrainz.org/ws/2'
const ARTWORK_ENDPOINT = 'https://coverartarchive.org'
const USER_AGENT = 'CyttoPlay/1.0.0 (https://github.com/CyttosPlay/CyttosPlay)'

/**
 * YouTube client flags for yt-dlp: force IPv4 (IPv6 ranges are routinely
 * bot-checked) and use the embed player client, which is served without the
 * sign-in challenge while still exposing the full format list. Fallback to
 * the default client happens automatically in runYtdlp (covers videos with
 * embedding disabled).
 */
const YT_CLIENT_ARGS = [
  '-4',
  '--extractor-args',
  'youtube:player_client=web_embedded',
  '--retries',
  '10',
  '--file-access-retries',
  '10',
  '--extractor-retries',
  '5'
]

export interface ProviderConfig {
  spotifyClientId: string
  spotifyClientSecret: string
  youtubeApiKey: string
  /** Free AcoustID API key (acoustid.org) enabling audio-fingerprint matching. */
  acoustidApiKey: string
}

/**
 * Rich track metadata resolved from a music catalog (Spotify when
 * credentials exist, otherwise the auth-free iTunes search API). Used to
 * embed proper title/artist/album/genre/cover into song downloads.
 */
export interface RichTrackMeta {
  provider: 'spotify' | 'jiosaavn' | 'deezer' | 'musicbrainz' | 'itunes' | 'acoustid'
  title: string
  artist: string
  album: string | null
  genres: string[]
  coverUrl: string | null
  durationSec: number | null
  /** Release year when the provider exposes one (e.g. JioSaavn/iTunes). */
  year?: number | null
  /** Music director / composer (MusicBrainz release artist-credit or title hint). */
  composer?: string | null
  /** Position within the album/soundtrack (1-based), when the provider knows it. */
  trackNo?: number | null
}

/** One queued playlist entry; `track` is present for Spotify sources. */
export interface ResolvedPlaylistEntry {
  videoId: string
  title: string
  duration?: number
  track?: { name: string; artists: string[]; album: string | null; durationMs: number | null }
}

/** Lookup context shared by the primary search and its verification pass. */
interface TrackMetaContext {
  videoId: string
  title: string
  query: string
  durationSec: number | null
  hints: string[]
  config: ProviderConfig
  /** Normalized movie-name segments used to prefer matching albums. */
  albumHints: string[]
  /** The album was located by its own tracklist (album tier), so the movie
   * relationship is already proven — the duration veto for edits applies
   * even when the album spelling drops the hint phrase ("Boss n' Baskaran"
   * vs "Boss (a) Baskaran"). */
  albumProven?: boolean
}

/** Strip "| separators", bracketed tags and "(Official Video…)" noise from a YouTube title. */
function cleanTrackQuery(raw: string): string {
  let t = String(raw ?? '').trim()
  if (!t) return ''
  t = t.replace(/[|｜]/g, '|').split('|')[0].trim()
  const strip = [
    /\([^)]*\)/g,
    /\[[^\]]*\]/g,
    /official\s+(full\s+)?(music\s+)?video\s+song/gi,
    /official\s+(full\s+)?(music\s+)?video/gi,
    /full\s+video\s+song/gi,
    /music\s+video/gi,
    /lyric\s+video/gi,
    /lyrical\s+video/gi,
    /video\s+song/gi,
    /audio\s+jukebox/gi,
    /with\s+lyrics/gi,
    /\blyrics\b/gi,
    /\blyrical\b/gi,
    /\bvisualizer\b/gi,
    /\bperformance\b/gi,
    /\bofficial\s+audio\b/gi,
    /\bhd\b/gi,
    /\bhq\b/gi,
    // Leftover standalone noise after the phrase removals above
    // ("Pesadhe Official Full Video Song" -> "Pesadhe Official").
    /\bofficial\b/gi
  ]
  for (const re of strip) t = t.replace(re, ' ')
  t = t.replace(/\s{2,}/g, ' ').trim()
  // "Kannamma - Video Song" strips down to "Kannamma -"; a dangling dash
  // pollutes every catalog query, so trim separators left/right.
  t = t.replace(/^[\s\-–—]+|[\s\-–—]+$/g, '')
  return t.slice(0, 120)
}

/** Collapse a phrase to lowercase normalized words (for containment checks). */
function normalizePhrase(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\u00c0-\u024f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Split a cleaned query like "Vaisagh - Wrong Way" into artist + title parts. */
function splitArtistTitle(query: string): { artist: string; title: string } | null {
  const m = /^(?:(.+?)\s+-\s+)?(.+)$/.exec(query.trim())
  if (!m) return null
  if (!m[1]) return null
  const artist = m[1].trim()
  const title = m[2].trim()
  if (!artist || !title) return null
  return { artist, title }
}

/** Decode HTML entities JioSaavn's API bakes into its JSON strings. */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

/** Strip label conventions from iTunes titles/albums: '(From "Album") [Tamil] - Single'. */
function stripLabelTag(s: string): string {
  return s
    .replace(/\s*-\s*single\s*$/i, '')
    .replace(/\s*-\s*ep\s*$/i, '')
    .replace(/\s*\[[^\]]+\]\s*$/i, '')
    .replace(/\s*\(from\s+"[^"]+"\)\s*$/i, '')
    .replace(/\s*\(from\s+"[^"]+"\)/i, '')
    .replace(/\s*-\s*(tamil|hindi|telugu|malayalam|kannada|punjabi)\s*$/i, '')
    .trim()
}

/** Channel segments of a YouTube title, split on "|" and trimmed. */
function titleSegments(raw: string): string[] {
  return String(raw ?? '')
    .replace(/[|｜]/g, '|')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Candidate artist hints from the channel segments of a YouTube title. */
function artistHints(raw: string): string[] {
  const segments = titleSegments(raw)
  const hints: string[] = []
  const seen = new Set<string>()
  const push = (s: string): void => {
    const clean = cleanTrackQuery(s).replace(/\b(a|an|the|songs|song|official|channel|topic)\b/gi, ' ').replace(/\s{2,}/g, ' ').trim()
    if (clean && clean.length >= 3 && clean.length <= 60 && !seen.has(clean.toLowerCase())) {
      seen.add(clean.toLowerCase())
      hints.push(clean)
    }
  }
  // Last segment is usually the composer/label/channel; then the first.
  if (segments.length > 1) push(segments[segments.length - 1])
  if (segments.length > 1) push(segments[0])
  return hints.slice(0, 2)
}

/** Words that disqualify a title segment from being an album hint. */
const ALBUM_HINT_NOISE = new Set([
  'video', 'song', 'songs', 'lyric', 'lyrics', 'lyrical', 'official', 'full',
  'hd', 'hq', '4k', '8k', 'audio', 'with', 'tamil', 'hindi', 'telugu',
  'malayalam', 'kannada', 'punjabi', 'english', 'music', 'movie', 'movies',
  'film', 'channel', 'topic', 'title', 'track', 'soundtrack', 'remix', 'live',
  'karaoke', 'cover', 'covers', 'version'
])

/** Words that disqualify a title segment from being a composer name. */
const NON_COMPOSER_WORDS = new Set([
  'a', 'an', 'the', 'and', 'feat', 'ft', 'duet', 'official', 'audio', 'music', 'label',
  'channel', 'song', 'songs', 'soundtrack', 'title', 'video', 'lyrics', 'lyric', 'hit',
  'hits', 'mix', 'mixes', 'remix', 'live', 'unplugged', 'movie', 'movies', 'film',
  'tamil', 'hindi', 'telugu', 'english', 'korean', 'india', 'indie', 'remastered',
  'instrumental', 'records', 'record', 'entertainment', 'production', 'productions',
  'studios', 'studio', 'released', 'release', 'cover', 'covers', 'version', 'karaoke'
])

/**
 * Music director guess from the channel segments of a YouTube title
 * ("Song | Movie | Actors | Director" — the last plausible name wins).
 */
function composerFromTitle(title: string, artist: string): string | null {
  const segments = titleSegments(title)
  if (segments.length < 2) return null
  for (let i = segments.length - 1; i >= 1; i--) {
    const s = segments[i].trim()
    if (!s || /[()[\],]/.test(s)) continue
    // Joint credits ("A & B", "A feat B") are singers, not a director.
    if (/[&×/]/.test(s)) continue
    const words = s.toLowerCase().split(/[^a-z0-9\u00c0-\u024f]+/).filter(Boolean)
    if (words.length < 2 || words.length > 5 || s.length > 45) continue
    if (words.some((w) => NON_COMPOSER_WORDS.has(w))) continue
    if (normalizePhrase(s) === normalizePhrase(artist)) continue
    return s
  }
  return null
}

/**
 * Ordered candidate search queries for a YouTube title. The first `|`
 * segment comes first (usually the song name), then the remaining segments
 * by descending length as fallbacks — covers titles that lead with the
 * album/movie/director/channel name ("OM | Alaakaa Loova Lyrical | …").
 * Segments that are too short or only noise/label words are skipped; a
 * wrong-but-passing first segment no longer traps the lookup.
 */
function candidateQueries(raw: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (q: string): void => {
    const clean = cleanTrackQuery(q)
    if (!clean || clean.length < 3) return
    const norm = clean.toLowerCase()
    if (seen.has(norm)) return
    seen.add(norm)
    const words = clean.split(/[^a-z0-9\u00c0-\u024f]+/).filter(Boolean)
    if (words.length > 0 && words.every((w) => NON_COMPOSER_WORDS.has(w))) return
    out.push(clean)
  }
  const segments = titleSegments(raw)
  if (segments.length === 0) return out
  push(segments[0])
  // "Artist - Title" titles also search by the title alone: catalogs spell
  // the track differently once the artist is dropped ("Minnale - Venmathi
  // Venmathiye" → "Venmathiye"), and the artist prefix often hides the
  // original soundtrack under remix/compilation copies.
  const split = splitArtistTitle(cleanTrackQuery(segments[0]))
  if (split) push(split.title)
  for (const s of segments.slice(1).sort((a, b) => b.length - a.length)) push(s)
  return out.slice(0, 4)
}

/** Whether two titles refer to the same track (normalized equality or containment). */
function sameTitle(a: string, b: string): boolean {
  const na = normalizePhrase(a)
  const nb = normalizePhrase(b)
  if (!na || !nb) return false
  if (na === nb) return true
  const short = na.length <= nb.length ? na : nb
  const long = short === na ? nb : na
  return short.length >= 4 && long.includes(short)
}

/**
 * The song-name query that fallback candidates must agree with. The first
 * query is normally the song segment of the YouTube title ("Iyley Iyley…"),
 * but movie-led titles open with a short movie name ("OM | …", "96 | …")
 * which is skipped — there the fallback queries carry the song names and
 * nothing anchors them.
 */
function firstQueryAnchor(queries: string[]): string | null {
  const first = queries[0]
  if (!first) return null
  return first.split(/\s+/).length >= 2 || first.length >= 6 ? first : null
}

/** Whether an artist name matches one of the title's channel segments. */
function artistInSegments(artist: string, segments: string[]): boolean {
  const na = normalizePhrase(artist)
  if (!na) return false
  // Containment of a segment inside the artist requires a non-trivial
  // segment ("sai" ⊂ "Sai Abhyankkar, Rokesh" is a weak, accidental hit),
  // while full equality or the reverse containment stay as strong signals.
  return segments.some(
    (s) => na === s || (s.length >= 4 && na.includes(s)) || s.includes(na)
  )
}

/** Escape a phrase for MusicBrainz' Lucene search syntax. */
function escapeLucene(s: string): string {
  return s.replace(/[\x5b\x5d"\\+\-!(){}[^~*?:/&|,;]/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

/** Fraction of query tokens that also appear in the candidate title (0..1). */
function titleTokenOverlap(query: string, title: string): number {
  const toks = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\u00c0-\u024f]+/g, ' ')
        .split(' ')
        .filter(Boolean)
    )
  const a = toks(query)
  const b = toks(title)
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / Math.min(a.size, b.size)
}

interface ScoredCandidate<T> {
  item: T
  score: number
  /** Seconds of deviation from the known duration; null when either side is unknown. */
  delta: number | null
}

/** Keep the highest-scoring candidate; break exact ties by duration closeness. */
function pickBest<T>(best: ScoredCandidate<T> | null, cand: ScoredCandidate<T>): ScoredCandidate<T> {
  if (!best) return cand
  if (cand.score > best.score) return cand
  if (cand.score === best.score) {
    const bd = best.delta == null ? Infinity : best.delta
    const cd = cand.delta == null ? Infinity : cand.delta
    if (cd < bd) return cand
  }
  return best
}

/** Exact phrase containment wins; partial token overlap is heavily discounted. */
function candidateNameScore(query: string, candTitle: string, candArtist?: string): number {
  const split = splitArtistTitle(query)
  if (split) {
    const nTitle = normalizePhrase(split.title)
    const nArtist = normalizePhrase(split.artist)
    const t = normalizePhrase(candTitle)
    if (nTitle && t && (t.includes(nTitle) || nTitle.includes(t))) return 1
    if (nArtist && candArtist) {
      const a = normalizePhrase(candArtist)
      if (a && (a.includes(nArtist) || nArtist.includes(a))) return 1
    }
  } else {
    const q = normalizePhrase(query)
    const t = normalizePhrase(candTitle)
    if (q && t && (t.includes(q) || q.includes(t))) return 1
  }
  return titleTokenOverlap(query, candTitle) * 0.5
}

/** 0..1 confidence for a candidate track vs the query title + known duration. */
function scoreCandidate(
  candTitle: string,
  durationMs: number | null,
  query: string,
  durationSec: number | null,
  candArtist?: string,
  /** Normalized movie-name segment from the YouTube title ("kaala"). When a
   * candidate's album contains it, the duration veto is relaxed: catalog
   * editions of the named film's track are routinely shorter/longer than
   * the YouTube upload, so an edit gap alone must not discard the match. */
  albumHint?: string
): number {
  const nameScore = candidateNameScore(query, candTitle, candArtist)
  const wordCount = query.trim().split(/\s+/).length
  let durScore = 0.5
  if (durationSec != null && durationMs != null && durationMs > 0) {
    const delta = Math.abs(durationMs / 1000 - durationSec)
    durScore = delta <= 3 ? 1 : delta <= 10 ? 0.85 : delta <= 20 ? 0.6 : 0
    // Duration is a strong tie-breaker, not a hard veto: movie-version
    // edits and extended uploads routinely shift lengths by >20s while the
    // title matches perfectly. Only reject outright when the title is weak
    // — or when the query is one or two words, because an exact short-name
    // match with a badly mismatched duration is usually a different track
    // that happens to share its name (a soundtrack/movie title like "OM"
    // or "Maragatha Naanayam" matching the title track instead of the
    // song that was actually downloaded). An album hint rescues the
    // named film's own editions (delta <= 90s) from that veto.
    if (durScore === 0 && (nameScore < 0.9 || wordCount <= 2)) {
      if (albumHint && delta <= 90) durScore = 0.3
      else return 0
    }
    if (durScore === 0) durScore = 0.5
  }
  // Very short queries are ambiguous: require a near-exact title match
  // without a duration, or a reasonably tight duration match when one is
  // known (an exact name still wins — the duration then breaks ties).
  if (wordCount < 3) {
    if (durationSec == null && nameScore < (wordCount === 1 ? 0.9 : 0.75)) return 0
    if (durationSec != null && nameScore < 0.9 && durScore < (wordCount === 1 ? 0.85 : 0.6)) return 0
  }
  return 0.65 * nameScore + 0.35 * durScore
}

/** Album names that are placeholder collections, not real albums. */
const COMPILATION_ALBUM_RE =
  /hits|\bvol\.?\s*\d|evergreen|delight|melod(y|ies)|collection|anthology|jukebox|^i\s*love\b|love\s*vibe|favorites?|greatest/i

/** Explicit soundtrack naming (the preferred album for film songs). */
const SOUNDTRACK_ALBUM_RE = /original\s*motion\s*picture|soundtrack|\bost\b/i

/**
 * Adjust a candidate's raw score by its title/album class: compilations
 * lose ("Big Hits, Vol. 1" must not beat the "Maragatha Naanayam"
 * soundtrack), explicit soundtracks win ties, an album containing the
 * movie name from the YouTube title gets a small boost, and a candidate
 * titled "Song (From &lt;query&gt;)" is a reference to a *different* song of
 * that movie — searching the movie name, not the song — so it loses.
 */
function adjustAlbumScore(
  score: number,
  album: string | null | undefined,
  albumHint: string,
  candTitle: string,
  query: string
): number {
  if (album && COMPILATION_ALBUM_RE.test(album)) score *= 0.75
  if (album && SOUNDTRACK_ALBUM_RE.test(album)) score += 0.1
  // A candidate whose album contains the movie name from the YouTube title
  // is the named film's own edition — that is the artwork the user expects.
  // The bump is large enough to beat a same-titled compilation/single copy
  // (which are already discounted above) while staying under the 1.0 name
  // score so a genuinely better-titled candidate still wins.
  if (albumHint && album && normalizePhrase(album).includes(albumHint)) score += 0.2
  const t = normalizePhrase(candTitle)
  const q = normalizePhrase(query)
  if (q && ` ${t} `.includes(` from ${q} `)) score *= 0.5
  // Allow the bonuses to break ties between equal near-perfect matches
  // (an OST copy vs a compilation copy of the same track both hitting 1.0);
  // candidates below the accept threshold are unaffected by the headroom.
  return Math.min(1.1, Math.max(0, score))
}

export interface ProviderStatus {
  spotifyConfigured: boolean
  youtubeConfigured: boolean
}

/** A single video stream for the internal video window. */
export interface VideoQualityStream {
  height: number
  url: string
  /** HLS manifest (played with hls.js) vs a direct media URL. */
  hls: boolean
  /** True when the stream is video-only DASH and needs the paired audio URL. */
  videoOnly: boolean
}

/** Per-video quality set: video streams by height + the best audio stream. */
export interface VideoQualitySet {
  streams: VideoQualityStream[]
  /** Best audio stream (m4a/AAC) to pair with video-only DASH; null when all streams are muxed. */
  audioUrl: string | null
  /** True when this set was produced by a live yt-dlp run (not the cache). */
  fresh?: boolean
}

interface CacheRow {
  payload: string
  fetched_at: number
  ttl: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isFfmpegBinary(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(bin, ['-version'], { timeout: 8000, windowsHide: true }, (err) => resolve(!err))
  })
}

function clampNum(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/** Parse a yt-dlp ETA string like "00:05" / "1:02:33" into seconds. */
function parseEta(s: string): number {
  const parts = s.split(':').map(Number)
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return 0
  return parts[0] * 3600 + parts[1] * 60 + parts[2]
}

/**
 * Provider abstraction.
 *
 * - Local library: served by the search engine, never this module.
 * - MusicBrainz + Cover Art Archive: public, free, authorized APIs used for
 *   artist biography and album artwork. Rate limited to ~1 req/s as required
 *   by MusicBrainz's usage policy.
 * - Spotify & YouTube: only activated when the user supplies their own API
 *   credentials in Settings (Client Credentials flow / Data API v3). No
 *   credentials are ever embedded in source code, and results are cached.
 */
export class ProviderService {
  private lastRequestAt = 0
  private spotifyToken: string | null = null
  private spotifyExpiresAt = 0

  constructor(private db: Database) {}

  private async pace(): Promise<void> {
    const now = Date.now()
    const wait = Math.max(0, 700 - (now - this.lastRequestAt))
    this.lastRequestAt = now
    if (wait > 0) await sleep(wait)
  }

  private cacheGet(key: string): unknown | null {
    const row = this.db.get<CacheRow>(
      'SELECT payload, fetched_at, ttl FROM provider_cache WHERE key = ?',
      [key]
    )
    if (!row) return null
    if (Date.now() - Number(row.fetched_at) > Number(row.ttl)) return null
    try {
      return JSON.parse(row.payload)
    } catch {
      return null
    }
  }

  private cacheSet(key: string, payload: unknown, ttlMs: number): void {
    this.db.run(
      `INSERT INTO provider_cache (key, payload, fetched_at, ttl)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         payload = excluded.payload, fetched_at = excluded.fetched_at, ttl = excluded.ttl`,
      [key, JSON.stringify(payload), Date.now(), ttlMs]
    )
  }

  private async fetchJson(url: string, headers?: Record<string, string>): Promise<unknown> {
    await this.pace()
    // MusicBrainz rate-limits (HTTP 503) and transient network blips are
    // common; retry once before giving up. The `null` result means "no
    // data" to every caller, so a retry here prevents silent gaps.
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 12000)
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
          signal: controller.signal
        })
        if (!res.ok) {
          // Provider HTTP failures (rate limits, throttling) are a known
          // source of silent metadata gaps; surface them instead of hiding.
          getLogger().warn(`Provider HTTP ${res.status} for ${url.slice(0, 120)}`)
          if (attempt === 0) {
            // MusicBrainz 503s mean "slow down"; iTunes 403s mean throttling.
            // A longer backoff gives the limit window time to pass.
            await sleep(res.status === 503 ? 3000 : 1500)
            continue
          }
          return null
        }
        return await res.json()
      } catch (err) {
        getLogger().debug(`Provider request failed: ${url}`, err)
        if (attempt === 0) {
          await sleep(1500)
          continue
        }
        return null
      } finally {
        clearTimeout(timer)
      }
    }
    return null
  }

  // -------------------------------------------------------------------------
  // MusicBrainz
  // -------------------------------------------------------------------------

  /** Artist biography source (Wikipedia link) via MusicBrainz. */
  async artistBiography(artistName: string): Promise<string | null> {
    const key = `mb:bio:${artistName.toLowerCase()}`
    const cached = this.cacheGet(key)
    if (cached !== null) return cached as string | null
    const query = encodeURIComponent(artistName.replace(/[''']/g, ''))
    const data = (await this.fetchJson(
      `${MB_ENDPOINT}/artist/?query=artist:${query}&fmt=json&limit=5`
    )) as { artists?: Array<{ id: string }> } | null
    if (!data?.artists || data.artists.length === 0) {
      this.cacheSet(key, null, 7 * 86400_000)
      return null
    }
    const artistId = data.artists[0].id
    const detail = (await this.fetchJson(`${MB_ENDPOINT}/artist/${artistId}?inc=url-rels&fmt=json`)) as {
      relations?: { url?: { resource?: string } }[]
    } | null
    let url: string | null = null
    if (detail?.relations) {
      const wikipedia = detail.relations.find((r) =>
        (r.url?.resource ?? '').includes('wikipedia.org')
      )
      url = wikipedia?.url?.resource ?? null
    }
    this.cacheSet(key, url || null, 14 * 86400_000)
    return url
  }

  /** Album artwork URL via Cover Art Archive (authorized public API). */
  async albumArtwork(artist: string, album: string): Promise<string | null> {
    const key = `mb-art:${artist.toLowerCase()}:${album.toLowerCase()}`
    const cached = this.cacheGet(key)
    if (cached !== null) return cached as string | null
    const query = encodeURIComponent(`artist:${artist} AND release:${album}`)
    const data = (await this.fetchJson(`${MB_ENDPOINT}/release/?query=${query}&fmt=json&limit=5`)) as {
      releases?: { id: string }[]
    } | null
    let cover: string | null = null
    if (data?.releases && data.releases.length > 0) {
      const releaseId = data.releases[0].id
      await this.pace()
      try {
        const res = await fetch(`${ARTWORK_ENDPOINT}/release/${releaseId}/front-250`, {
          headers: { 'User-Agent': USER_AGENT }
        })
        if (res.ok) cover = `${ARTWORK_ENDPOINT}/release/${releaseId}/front-250`
      } catch {
        cover = null
      }
    }
    this.cacheSet(key, cover, 14 * 86400_000)
    return cover
  }

  // -------------------------------------------------------------------------
  // Spotify (optional — requires user-provided credentials)
  // -------------------------------------------------------------------------

  private async spotifyAccessToken(config: ProviderConfig): Promise<string | null> {
    if (this.spotifyToken && this.spotifyExpiresAt > Date.now()) return this.spotifyToken
    if (!config.spotifyClientId || !config.spotifyClientSecret) return null
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10000)
      const res = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(
            `${config.spotifyClientId}:${config.spotifyClientSecret}`
          ).toString('base64')}`
        },
        body: 'grant_type=client_credentials',
        signal: controller.signal
      })
      clearTimeout(timer)
      if (!res.ok) return null
      const body = (await res.json()) as { access_token: string; expires_in: number }
      this.spotifyToken = body.access_token
      this.spotifyExpiresAt = Date.now() + (body.expires_in - 60) * 1000
      return this.spotifyToken
    } catch (err) {
      getLogger().debug('Spotify token request failed', err)
      return null
    }
  }

  /** Metadata-only catalog search (Client Credentials flow, no DRM, no playback). */
  async searchSpotify(query: string, config: ProviderConfig): Promise<OnlineSearchResult[]> {
    const token = await this.spotifyAccessToken(config)
    if (!token) return []
    const key = `sp:${query.toLowerCase()}`
    const cached = this.cacheGet(key)
    if (cached !== null) return cached as OnlineSearchResult[]
    const params = new URLSearchParams({ q: query, type: 'track', limit: '20' })
    const data = (await this.fetchJson(
      `https://api.spotify.com/v1/search?${params.toString()}`,
      { Authorization: `Bearer ${token}` }
    )) as {
      tracks?: {
        items?: Array<{
          id: string
          name: string
          album?: { name: string; images?: { url: string }[] }
          artists: { name: string }[]
          duration_ms?: number
          external_urls?: { spotify: string }
          preview_url?: string | null
          release_date?: string
        }>
      }
    } | null
    const items = data?.tracks?.items ?? []
    const results: OnlineSearchResult[] = items.map((item) => ({
      provider: 'spotify',
      id: `spotify:${item.id}`,
      title: item.name ?? 'Untitled',
      artist: item.artists.map((a) => a.name).join(', '),
      album: item.album?.name ?? null,
      duration: item.duration_ms ? item.duration_ms / 1000 : null,
      year: item.release_date ? Number(item.release_date.slice(0, 4)) || null : null,
      artworkUrl: item.album?.images?.[0]?.url ?? null,
      url: item.external_urls?.spotify ?? '',
      previewUrl: item.preview_url ?? null
    }))
    this.cacheSet(key, results, 3600_000)
    return results
  }

  // -------------------------------------------------------------------------
  // YouTube (optional — requires user-provided API key)
  // -------------------------------------------------------------------------

  /** Metadata-only search via YouTube Data API v3. */
  async searchYouTube(query: string, config: ProviderConfig): Promise<OnlineSearchResult[]> {
    const key = `yt:${query.toLowerCase()}`
    const cached = this.cacheGet(key)
    if (Array.isArray(cached) && cached.length > 0) return cached as OnlineSearchResult[]
    let results: OnlineSearchResult[] = []
    if (config.youtubeApiKey) {
      const params = new URLSearchParams({
        part: 'snippet',
        type: 'video',
        videoCategoryId: '10',
        maxResults: '20',
        q: query,
        key: config.youtubeApiKey
      })
      const data = (await this.fetchJson(
        `https://www.googleapis.com/youtube/v3/search?${params.toString()}`
      )) as {
        items?: Array<{
          id: { videoId: string }
          snippet: {
            title: string
            channelTitle: string
            thumbnails?: { medium?: { url: string } }
            publishedAt: string
          }
        }>
      } | null
      const items = data?.items ?? []
      results = items.map((item) => ({
        provider: 'youtube',
        id: `youtube:${item.id?.videoId ?? ''}`,
        title: item.snippet?.title ?? 'Untitled',
        artist: item.snippet?.channelTitle ?? 'Unknown',
        album: null,
        duration: null,
        year: item.snippet?.publishedAt ? Number(item.snippet.publishedAt.slice(0, 4)) || null : null,
        artworkUrl: item.snippet?.thumbnails?.medium?.url ?? null,
        url: `https://www.youtube.com/watch?v=${item.id?.videoId ?? ''}`,
        previewUrl: null,
        videoId: item.id?.videoId ?? null
      }))
    }
    if (results.length === 0) {
      // API key missing, quota exhausted or no API results: fall back to the
      // bundled yt-dlp binary (`ytsearch:` extractor) — no API, no quota.
      results = await this.searchYouTubeViaYtdlp(query)
    }
    if (results.length > 0) this.cacheSet(key, results, 3600_000)
    return results
  }

  /** YouTube search via the bundled yt-dlp binary (no API key, no quota). */
  private async searchYouTubeViaYtdlp(query: string): Promise<OnlineSearchResult[]> {
    if (!query.trim()) return []
    const stdout = await this.runYtdlp([
      '--no-warnings',
      '--no-progress',
      '--flat-playlist',
      '-J',
      `ytsearch20:${query}`
    ])
    if (!stdout) return []
    try {
      const info = JSON.parse(stdout) as {
        entries?: Array<{
          id?: string
          title?: string
          channel?: string
          duration?: number
          thumbnails?: Array<{ url?: string }>
        }>
      }
      const entries = Array.isArray(info.entries) ? info.entries : []
      return entries
        .filter((e) => e.id && e.title)
        .map((e) => ({
          provider: 'youtube',
          id: `youtube:${e.id}`,
          title: e.title ?? 'Untitled',
          artist: e.channel ?? 'Unknown',
          album: null,
          duration: typeof e.duration === 'number' && e.duration > 0 ? e.duration : null,
          year: null,
          artworkUrl: e.thumbnails?.find((t) => t.url)?.url ?? null,
          url: `https://www.youtube.com/watch?v=${e.id}`,
          previewUrl: null,
          videoId: e.id
        }))
    } catch {
      return []
    }
  }

  /**
   * Resolve EVERY video of a playlist to {videoId, title} pairs so the
   * download queue can enqueue them all. YouTube playlists resolve through
   * yt-dlp's flat playlist listing (fast, no per-video metadata); Spotify
   * playlists resolve via the API, then each track is matched to its YouTube
   * video with a `ytsearch1` query (audio source = YouTube). Entries carry
   * the video duration and, for Spotify sources, the exact source track
   * metadata so downloads can be tagged without an extra lookup.
   */
  async resolvePlaylistEntries(
    url: string,
    config: ProviderConfig
  ): Promise<{ entries: ResolvedPlaylistEntry[]; error?: string; capped?: boolean }> {
    try {
      const u = new URL(url)
      if (/^(www\.|m\.|music\.)?youtube\.com$/i.test(u.hostname) || u.hostname === 'youtu.be') {
        return await this.resolveYouTubePlaylist(url)
      }
      if (u.hostname === 'open.spotify.com' && u.pathname.startsWith('/playlist/')) {
        return await this.resolveSpotifyPlaylist(u.pathname.split('/')[2] ?? '', config)
      }
    } catch {
      // fall through to the non-URL forms below
    }
    if (/^spotify:playlist:[A-Za-z0-9]+/.test(url)) {
      return await this.resolveSpotifyPlaylist(url.split(':')[2] ?? '', config)
    }
    return { entries: [] }
  }

  /** YouTube playlist (or single video URL) -> flat video id + title list. */
  private async resolveYouTubePlaylist(
    url: string
  ): Promise<{ entries: ResolvedPlaylistEntry[]; capped?: boolean }> {
    const stdout = await this.runYtdlp(['--no-warnings', '--flat-playlist', '-J', url], 120_000)
    if (!stdout) return { entries: [] }
    try {
      const info = JSON.parse(stdout) as {
        entries?: Array<{ id?: string; title?: string; duration?: number }>
      }
      const all = (info.entries ?? []).filter(
        (e) => e.id && /^[\w-]{11}$/.test(e.id) && e.title
      )
      const entries = all.slice(0, 200).map((e) => ({
        videoId: e.id as string,
        title: e.title as string,
        duration: typeof e.duration === 'number' ? e.duration : undefined
      }))
      return { entries, capped: all.length > 200 }
    } catch {
      return { entries: [] }
    }
  }

  /** Spotify playlist -> each track matched to its YouTube video. */
  private async resolveSpotifyPlaylist(
    playlistId: string,
    config: ProviderConfig
  ): Promise<{ entries: ResolvedPlaylistEntry[]; error?: string }> {
    const token = await this.spotifyAccessToken(config)
    if (!token) {
      return {
        entries: [],
        error: 'Spotify not configured — add your Client ID/Secret in Settings to download Spotify playlists.'
      }
    }
    const tracks: Array<{
      name: string
      artists: string[]
      album: string | null
      durationMs: number | null
    }> = []
    let offset = 0
    while (offset < 200) {
      const data = (await this.fetchJson(
        `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100&offset=${offset}`,
        { Authorization: `Bearer ${token}` }
      )) as {
        items?: Array<{
          track?: {
            name?: string
            artists?: { name: string }[]
            album?: { name?: string } | null
            duration_ms?: number
          }
        }>
      } | null
      const items = data?.items ?? []
      if (items.length === 0) break
      for (const item of items) {
        if (!item.track?.name) continue
        tracks.push({
          name: item.track.name,
          artists: (item.track.artists ?? []).map((a) => a.name).filter(Boolean),
          album: item.track.album?.name ?? null,
          durationMs: typeof item.track.duration_ms === 'number' ? item.track.duration_ms : null
        })
      }
      if (items.length < 100) break
      offset += 100
    }
    const entries: ResolvedPlaylistEntry[] = []
    const worker = async (track: (typeof tracks)[number]): Promise<void> => {
      const query = `${track.artists.join(' ')} ${track.name}`
      const stdout = await this.runYtdlp(
        ['--no-warnings', '--flat-playlist', '-J', `ytsearch1:${query}`],
        30_000
      )
      if (!stdout) return
      try {
        const info = JSON.parse(stdout) as { entries?: Array<{ id?: string; title?: string; duration?: number }> }
        const first = info.entries?.find((e) => e.id && /^[\w-]{11}$/.test(e.id))
        if (first?.id && first.title) {
          entries.push({
            videoId: first.id,
            title: first.title,
            duration: typeof first.duration === 'number' ? first.duration : undefined,
            track: {
              name: track.name,
              artists: track.artists,
              album: track.album,
              durationMs: track.durationMs
            }
          })
        }
      } catch {
        // skip this track
      }
    }
    // Small parallel pool (3) so YouTube stays polite and results still flow.
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(3, tracks.length) }, async () => {
        for (;;) {
          const idx = next++
          if (idx >= tracks.length) return
          await worker(tracks[idx])
        }
      })
    )
    return { entries }
  }

  // -------------------------------------------------------------------------
  // Song metadata enrichment (Spotify / iTunes) for downloads
  // -------------------------------------------------------------------------

  private trackMetaCache = new Map<
    string,
    { p: Promise<RichTrackMeta | null>; ok: boolean; at: number; dur: boolean }
  >()
  private artistGenres = new Map<string, string[]>()

  /**
   * Resolve rich metadata (title/artist/album/genre/cover) for a downloaded
   * song by matching its YouTube title against Spotify (when configured) or
   * the auth-free iTunes catalog. Results are cached per video id, so the
   * prefetch pipeline and the tagging step share a single lookup.
   *
   * Tag time (`fresh`) is the authority: it knows the full title and the
   * real duration, so it re-runs the lookup when the prefetch match was made
   * without a duration (that can be a cover/remix outranking the original),
   * keeping the cached match only as a fallback.
   */
  async resolveTrackMeta(
    videoId: string,
    title: string,
    durationSec: number | null,
    config: ProviderConfig,
    fresh = false,
    force = false
  ): Promise<RichTrackMeta | null> {
    if (!videoId) return null
    if (force) {
      // User-initiated metadata fix: ignore every cache, re-resolve now.
      const result = await this.lookupTrackMeta(videoId, title, durationSec, config)
      this.trackMetaCache.set(videoId, {
        p: Promise.resolve(result),
        ok: result != null,
        at: Date.now(),
        dur: durationSec != null
      })
      return result
    }
    const cached = this.trackMetaCache.get(videoId)
    const needsVerification = fresh || (durationSec != null && cached != null && !cached.dur && cached.ok)
    if (needsVerification) {
      const result = await this.lookupTrackMeta(videoId, title, durationSec, config)
      if (result) {
        this.trackMetaCache.set(videoId, {
          p: Promise.resolve(result),
          ok: true,
          at: Date.now(),
          dur: true
        })
        return result
      }
      if (cached && cached.ok) return cached.p
      return null
    }
    if (cached) {
      // Positive results are always reused. Negative results dedupe prefetch
      // sweeps briefly, then expire so a later attempt gets a fresh chance.
      if (cached.ok || Date.now() - cached.at < 60_000) return cached.p
      this.trackMetaCache.delete(videoId)
    }
    const p = this.lookupTrackMeta(videoId, title, durationSec, config)
    const state = { p, ok: false, at: Date.now(), dur: durationSec != null }
    this.trackMetaCache.set(videoId, state)
    p.then((result) => {
      state.ok = result != null
    }).catch(() => {})
    return p
  }

  private async lookupTrackMeta(
    videoId: string,
    title: string,
    durationSec: number | null,
    config: ProviderConfig
  ): Promise<RichTrackMeta | null> {
    try {
      const queries = candidateQueries(title)
      if (queries.length === 0) {
        getLogger().debug(`no usable query for ${videoId} (title "${title}")`)
        return null
      }
      const hints = artistHints(title)
      // Movie-name segments (everything after the song segment) double as
      // album hints: candidates whose album contains one get preferred, so
      // the cover follows the named film's soundtrack instead of a
      // same-titled compilation/remix copy. Short movie names ("96", "OM",
      // "7G", "PS1") are kept — they are exactly the soundtrack albums the
      // hint system exists to find — while noise/label words are dropped.
      const albumHints = Array.from(
        new Set(
          titleSegments(title)
            .slice(1)
            .map((s) => normalizePhrase(cleanTrackQuery(s)))
            .filter((s) => s.length >= 2 && s.length <= 40)
            .filter((s) => !s.split(' ').every((w) => ALBUM_HINT_NOISE.has(w)))
        )
      )
      // "Neelothi (From "Sirai")" carries its album in parens instead of a
      // "|" segment; harvest it the same way.
      const fromAlbum = /\(from\s+"([^"]+)"\)/i.exec(title)
      if (fromAlbum) {
        const hint = normalizePhrase(fromAlbum[1])
        if (hint && !albumHints.includes(hint)) albumHints.push(hint)
      }
      // Normalized channel segments — corroborate containment-only name
      // matches ("Pesadhe" ⊂ "Kannale Pesadhe (feat. K Sathish)"), where the
      // longer title is usually a different track that merely shares a word.
      const segments = titleSegments(title).slice(1).map(normalizePhrase).filter(Boolean)
      // Fallback queries (movie/actor/composer segments) may only confirm a
      // candidate whose title already matches the song segment: a movie-name
      // query must never guess a *different* song of that movie ("Yaar
      // Solli" must not become "Pathinaru Padimeethu").
      const anchor = firstQueryAnchor(queries)
      // Mutable container: control-flow analysis can't see assignments made
      // inside the `consider` closure, so a plain `let` would be narrowed to
      // `never` at the read site.
      const state: {
        best: {
          meta: RichTrackMeta
          score: number
          ctx: TrackMetaContext
          mbHintUsed: string
        } | null
      } = { best: null }
      // Judge a provider result against the acceptance rules; returns true
      // when the match is strong enough to stop searching (a weak match
      // keeps the lookup alive so a later query can confirm the real track
      // — "Theme Music" [Padayappa] must not beat "Pathinaru (Theme Music)").
      const consider = (meta: RichTrackMeta | null, ctx: TrackMetaContext, mbHintUsed = ''): boolean => {
        if (!meta || !meta.title) return false
        if (anchor && ctx.query !== queries[0] && !sameTitle(anchor, meta.title)) {
          getLogger().debug(
            `fallback ${videoId}: "${meta.title}" (${meta.provider}) does not match song anchor "${anchor}"`
          )
          return false
        }
        const qn = normalizePhrase(ctx.query)
        const tn = normalizePhrase(meta.title)
        const containmentOnly = qn !== tn && tn.includes(qn) && tn.length > qn.length
        if (containmentOnly) {
          const corroborated =
            albumHints.some((h) => normalizePhrase(meta.album ?? '').includes(h)) ||
            artistInSegments(meta.artist ?? '', segments)
          if (!corroborated) {
            getLogger().debug(
              `unverified ${videoId}: "${meta.title}" (${meta.provider}) only contains query "${ctx.query}"`
            )
            return false
          }
        }
        const albumHint = ctx.albumProven
          ? (albumHints.find((h) => normalizePhrase(meta.album ?? '').includes(h)) ?? albumHints[0] ?? '')
          : albumHints.find((h) => normalizePhrase(meta.album ?? '').includes(h)) ?? ''
        const score = adjustAlbumScore(
          scoreCandidate(
            meta.title,
            meta.durationSec != null ? meta.durationSec * 1000 : null,
            ctx.query,
            durationSec,
            meta.artist,
            albumHint
          ),
          meta.album,
          albumHint,
          meta.title,
          ctx.query
        )
        const delta =
          durationSec != null && meta.durationSec != null
            ? Math.abs(meta.durationSec - durationSec)
            : null
        const prev = state.best
        const bd =
          prev != null && durationSec != null && prev.meta.durationSec != null
            ? Math.abs(prev.meta.durationSec - durationSec)
            : null
        if (
          prev == null ||
          score > prev.score ||
          (score === prev.score && (bd == null || (delta != null && delta < bd)))
        ) {
          state.best = { meta, score, ctx, mbHintUsed }
        }
        getLogger().debug(`candidate ${videoId}: ${meta.provider} "${meta.title}" score=${score.toFixed(2)}`)
        return score >= 0.9
      }
      outer: for (const query of queries) {
        const ctx: TrackMetaContext = { videoId, title, query, durationSec, hints, config, albumHints }
        const spotify = await this.searchSpotifyTrack(query, durationSec, config, albumHints)
        if (consider(spotify, ctx)) break
        // JioSaavn (no credentials) is the authoritative catalog for Indian
        // film music, where Spotify/MusicBrainz/iTunes are frequently wrong,
        // missing or outdated. It sits ahead of Deezer/MusicBrainz so Tamil
        // and Telugu soundtrack songs resolve with correct album/year/cover.
        const jiosaavn = await this.searchJioSaavnTrack(query, durationSec, albumHints)
        if (consider(jiosaavn, ctx)) break
        // Deezer is the anonymous fallback for Spotify: its public search API
        // needs no credentials and its catalog (incl. Indian film music) ships
        // album art + exact durations. Kept ahead of MusicBrainz/iTunes, which
        // rate-limit hard (MusicBrainz 503s under load).
        const deezer = await this.searchDeezerTrack(query, durationSec, albumHints)
        if (consider(deezer, ctx)) break
        // MusicBrainz is the best catalog for film soundtracks; the channel
        // segments of the YouTube title double as artist hints.
        for (const hint of hints) {
          const mb = await this.searchMusicBrainzTrack(query, hint, durationSec, albumHints)
          if (consider(mb, ctx, hint)) break outer
        }
        const itunes = await this.searchItunesTrack(query, durationSec, albumHints)
        if (consider(itunes, ctx)) break
        getLogger().debug(`no track meta match for ${videoId} (query "${query}")`)
      }
      // JioSaavn album-tracklist tier: when every song query came up empty —
      // or only weakly ("Mama Mama" → a same-titled track of another film) —
      // resolve the song from the movie's own soundtrack instead. JioSaavn's
      // song search is flaky for transliterated spellings ("Iyley Iyley"
      // sometimes never surfaces), but the album always lists every song with
      // durations; the song-name anchor gates the candidates, so this tier
      // can only confirm the real song — never guess a different one. It also
      // supplies the track number, which fixes album sorting.
      if ((!state.best || state.best.score < 0.9) && albumHints.length > 0) {
        const songQuery = anchor ?? queries[0]
        const albumMeta = songQuery
          ? await this.searchJioSaavnAlbumTrack(songQuery, durationSec, albumHints)
          : null
        if (albumMeta) {
          const ctx: TrackMetaContext = {
            videoId,
            title,
            query: songQuery,
            durationSec,
            hints,
            config,
            albumHints,
            albumProven: true
          }
          consider(albumMeta, ctx)
        }
      }
      const winner = state.best
      if (!winner) return null
      const final = await this.verifyTrackMeta(winner.meta, winner.ctx, winner.mbHintUsed)
      getLogger().info(
        `track meta for ${videoId}: ${final.provider} "${final.title}" — ${final.artist} (score ${winner.score.toFixed(2)})`
      )
      return final
    } catch (err) {
      getLogger().debug(`track meta lookup failed for ${videoId}`, err)
      return null
    }
  }

  /**
   * Cross-check a catalog match against one more source. When the second
   * source finds the same track but credits a different artist, and that
   * artist appears in the YouTube title's channel segments while the
   * primary's does not, switch to it — but only when its duration matches
   * the video at least as well as the primary's (guards against cover
   * versions and re-recordings). Also harvests the music director from a
   * MusicBrainz result even when the artist is kept.
   */
  private async verifyTrackMeta(
    primary: RichTrackMeta,
    ctx: TrackMetaContext,
    mbHintUsed = ''
  ): Promise<RichTrackMeta> {
    const segments = titleSegments(ctx.title).slice(1).map(normalizePhrase).filter(Boolean)
    const secondary =
      primary.provider === 'musicbrainz'
        ? await this.searchItunesTrack(ctx.query, ctx.durationSec, ctx.albumHints)
        : await this.searchMusicBrainzTrack(
            ctx.query,
            mbHintUsed || ctx.hints[0] || '',
            ctx.durationSec,
            ctx.albumHints
          )
    let final = primary
    if (secondary && secondary.title && sameTitle(primary.title, secondary.title)) {
      const primaryInSegments = artistInSegments(primary.artist, segments)
      const secondaryInSegments = artistInSegments(secondary.artist, segments)
      const deltaOf = (m: RichTrackMeta): number | null =>
        ctx.durationSec != null && m.durationSec != null
          ? Math.abs(m.durationSec - ctx.durationSec)
          : null
      const dP = deltaOf(primary)
      const dS = deltaOf(secondary)
      if (!primaryInSegments && secondaryInSegments && (dS != null && (dP == null || dS <= dP))) {
        getLogger().info(
          `verified ${ctx.videoId}: "${primary.title}" — ${primary.artist} (${primary.provider}) -> "${secondary.title}" — ${secondary.artist} (${secondary.provider})`
        )
        final = secondary
      } else {
        getLogger().debug(
          `verified ${ctx.videoId}: kept ${primary.provider} "${primary.artist}" over ${secondary.provider} "${secondary.artist}"`
        )
      }
    }
    // Composer comes from MusicBrainz release credits, the catalog title, or
    // the channel segments of the YouTube title as a last resort — only when
    // nothing else reported one. The segments are often cast/label names
    // ("... | Sai Pallavi | Sreeleela | ..."), so they fill a gap but never
    // override a catalog composer.
    const mb = final.provider === 'musicbrainz' ? final : secondary?.provider === 'musicbrainz' ? secondary : null
    const composer =
      mb?.composer || final.composer || composerFromTitle(ctx.title, final.artist ?? '') || null
    return composer ? { ...final, composer } : final
  }

  /** Spotify search (only when credentials are configured). */
  private async searchSpotifyTrack(
    query: string,
    durationSec: number | null,
    config: ProviderConfig,
    albumHints: string[]
  ): Promise<RichTrackMeta | null> {
    const token = await this.spotifyAccessToken(config)
    if (!token) return null
    const params = new URLSearchParams({ q: query, type: 'track', limit: '10' })
    const data = (await this.fetchJson(`https://api.spotify.com/v1/search?${params.toString()}`, {
      Authorization: `Bearer ${token}`
    })) as {
      tracks?: {
        items?: Array<{
          name?: string
          duration_ms?: number
          track_number?: number
          artists?: Array<{ id?: string; name?: string }>
          album?: { name?: string; images?: Array<{ url?: string }> }
          release_date?: string
        }>
      }
    } | null
    const items = data?.tracks?.items ?? []
    if (items.length === 0) return null
    let best: ScoredCandidate<(typeof items)[number]> | null = null
    for (const it of items) {
      if (!it.name) continue
      const durSec = it.duration_ms ? Math.round(it.duration_ms / 1000) : null
      const album = it.album?.name ?? null
      const albumHint = albumHints.find((h) => normalizePhrase(album ?? '').includes(h)) ?? ''
      const cand: ScoredCandidate<(typeof items)[number]> = {
        item: it,
        score: adjustAlbumScore(
          scoreCandidate(
            it.name,
            it.duration_ms ?? null,
            query,
            durationSec,
            (it.artists ?? []).map((a) => a.name).filter(Boolean).join(' '),
            albumHint
          ),
          album,
          albumHint,
          it.name,
          query
        ),
        delta:
          durationSec != null && durSec != null
            ? Math.abs(durSec - durationSec)
            : null
      }
      best = pickBest(best, cand)
    }
    if (!best || best.score < 0.55) return null
    const genres: string[] = []
    for (const artist of best.item.artists ?? []) {
      if (!artist.id) continue
      let g = this.artistGenres.get(artist.id)
      if (!g) {
        const ad = (await this.fetchJson(`https://api.spotify.com/v1/artists/${artist.id}`, {
          Authorization: `Bearer ${token}`
        })) as { genres?: string[] } | null
        g = (ad?.genres ?? []).slice(0, 3)
        this.artistGenres.set(artist.id, g)
      }
      for (const x of g) if (!genres.includes(x)) genres.push(x)
      if (genres.length >= 2) break
    }
    return {
      provider: 'spotify',
      title: best.item.name as string,
      artist: (best.item.artists ?? []).map((a) => a.name).filter(Boolean).join(', '),
      album: best.item.album?.name ?? null,
      genres,
      coverUrl: best.item.album?.images?.find((i) => i.url)?.url ?? null,
      durationSec: best.item.duration_ms ? Math.round(best.item.duration_ms / 1000) : null,
      year: best.item.release_date ? Number(best.item.release_date.slice(0, 4)) || null : null,
      trackNo: best.item.track_number != null ? Number(best.item.track_number) : null
    }
  }

  /** MusicBrainz recording search — best catalog for film soundtracks. */
  private async searchMusicBrainzTrack(
    query: string,
    artistHint: string,
    durationSec: number | null,
    albumHints: string[]
  ): Promise<RichTrackMeta | null> {
    const q = `recording:"${escapeLucene(query)}" AND artist:"${escapeLucene(artistHint)}"`
    const data = (await this.fetchJson(
      `${MB_ENDPOINT}/recording/?query=${encodeURIComponent(q)}&fmt=json&inc=artist-credits&limit=8`
    )) as {
      recordings?: Array<{
        id?: string
        title?: string
        length?: number
        'artist-credit'?: Array<{ name?: string; joinphrase?: string }>
        releases?: Array<{
          id?: string
          title?: string
          date?: string
          'artist-credit'?: Array<{ name?: string; joinphrase?: string }>
        }>
      }>
    } | null
    const items = data?.recordings ?? []
    if (items.length === 0) {
      getLogger().debug(`musicbrainz "${query}" / "${artistHint}" -> no recordings`)
      return null
    }
    let best: ScoredCandidate<(typeof items)[number]> | null = null
    for (const r of items) {
      if (!r.title) continue
      const durSec = r.length ? Math.round(r.length / 1000) : null
      const album = r.releases?.[0]?.title ?? null
      const albumHint =
        albumHints.find((h) => normalizePhrase(album ?? '').includes(h)) ?? ''
      const cand: ScoredCandidate<(typeof items)[number]> = {
        item: r,
        score: adjustAlbumScore(
          scoreCandidate(
            r.title,
            r.length ?? null,
            query,
            durationSec,
            (r['artist-credit'] ?? []).map((a) => (a.name ?? '') + (a.joinphrase ?? '')).join(''),
            albumHint
          ),
          album,
          albumHint,
          r.title,
          query
        ),
        delta:
          durationSec != null && durSec != null
            ? Math.abs(durSec - durationSec)
            : null
      }
      best = pickBest(best, cand)
    }
    if (!best || best.score < 0.55) return null
    const genres: string[] = []
    if (best.item.id) {
      const detail = (await this.fetchJson(
        `${MB_ENDPOINT}/recording/${best.item.id}?inc=genres&fmt=json`
      )) as { genres?: Array<{ name?: string }> } | null
      for (const g of detail?.genres ?? []) {
        if (g.name) genres.push(g.name)
        if (genres.length >= 2) break
      }
    }
    const release = best.item.releases?.[0]
    const artist = (best.item['artist-credit'] ?? [])
      .map((a) => (a.name ?? '') + (a.joinphrase ?? ''))
      .join('')
    // Film soundtrack releases credit the music director as the release
    // artist ("Thirudan Police (OST)" -> Yuvan Shankar Raja).
    const releaseArtist = (release?.['artist-credit'] ?? [])
      .map((a) => (a.name ?? '') + (a.joinphrase ?? ''))
      .join('')
    const composer =
      releaseArtist && normalizePhrase(releaseArtist) !== normalizePhrase(artist) ? releaseArtist : null
    return {
      provider: 'musicbrainz',
      title: stripLabelTag(best.item.title as string),
      artist,
      album: stripLabelTag(
        (release?.title ?? null)?.replace(
          /\s*\((original\s+)?motion\s+picture\s+(soundtrack|score)|ost|soundtrack\)\s*$/i,
          ''
        ) ?? ''
      ) || null,
      genres,
      coverUrl: release?.id ? `https://coverartarchive.org/release/${release.id}/front-500` : null,
      durationSec: best.item.length ? Math.round(best.item.length / 1000) : null,
      year: release?.date ? Number(release.date.slice(0, 4)) || null : null,
      composer
    }
  }

  /** JioSaavn — no credentials; best catalog for Indian film music. */
  private async searchJioSaavnTrack(
    query: string,
    durationSec: number | null,
    albumHints: string[]
  ): Promise<RichTrackMeta | null> {
    const params = new URLSearchParams({
      __call: 'search.getResults',
      _format: 'json',
      _marker: '0',
      ctx: 'web6dot0',
      cc: 'in',
      q: query
    })
    const data = (await this.fetchJson(
      `https://www.jiosaavn.com/api.php?${params.toString()}`
    )) as {
      results?: Array<{
        id?: string
        title?: string
        song?: string
        duration?: string | number
        singers?: string
        primary_artists?: string
        music?: string
        album?: string
        year?: string | number
        image?: string
      }>
    } | null
    const items = Array.isArray(data?.results) ? data.results : []
    if (items.length === 0) {
      getLogger().debug(`jiosaavn search "${query}" -> no results (duration ${durationSec})`)
      return null
    }
    let best: ScoredCandidate<(typeof items)[number]> | null = null
    for (const r of items) {
      // JioSaavn bakes literal "&quot;" entities into titles/albums; scoring
      // must use decoded text or the "(From &quot;Movie&quot;)" markers never
      // match the downrank rule (normalizePhrase would read them as "quot").
      const title = decodeHtmlEntities(r.title ?? r.song ?? '')
      if (!title) continue
      const durSec = r.duration != null ? Math.round(Number(r.duration)) : null
      const album = r.album ? decodeHtmlEntities(r.album) : null
      const albumHint = albumHints.find((h) => normalizePhrase(album ?? '').includes(h)) ?? ''
      const cand: ScoredCandidate<(typeof items)[number]> = {
        item: r,
        score: adjustAlbumScore(
          scoreCandidate(
            title,
            durSec != null && durSec > 0 ? durSec * 1000 : null,
            query,
            durationSec,
            r.singers || r.primary_artists,
            albumHint
          ),
          album,
          albumHint,
          title,
          query
        ),
        delta:
          durationSec != null && durSec != null && durSec > 0
            ? Math.abs(durSec - durationSec)
            : null
      }
      best = pickBest(best, cand)
    }
    if (!best || best.score < 0.55) return null
    const title = (best.item.title ?? best.item.song) as string
    const durSec = best.item.duration != null ? Math.round(Number(best.item.duration)) : null
    const year = best.item.year != null ? Number(best.item.year) : null
    const artist = decodeHtmlEntities(best.item.singers || best.item.primary_artists || '')
    // JioSaavn's `music` field sometimes duplicates the full artist list
    // instead of the actual composer; a duplicate composer tag is worse
    // than none.
    const music = best.item.music ? decodeHtmlEntities(best.item.music) : null
    const composer =
      music && normalizePhrase(music) !== normalizePhrase(artist) ? music : null
    return {
      provider: 'jiosaavn',
      title: stripLabelTag(decodeHtmlEntities(title)),
      artist,
      album: best.item.album ? stripLabelTag(decodeHtmlEntities(best.item.album)) : null,
      genres: [],
      coverUrl: best.item.image ?? null,
      durationSec: durSec != null && durSec > 0 ? durSec : null,
      year: year != null && year > 1900 ? year : null,
      composer
    }
  }

  /**
   * JioSaavn album-tracklist fallback: search the movie's soundtrack album
   * (via the album-hint segments) and match the song inside its tracklist by
   * name + duration. Every song in the matched album is the film's own
   * edition, so the duration veto is relaxed for upload edits (delta ≤ 90s).
   * The 1-based position in the deduplicated tracklist doubles as the track
   * number, so a movie's downloads sort by the official order.
   */
  private async searchJioSaavnAlbumTrack(
    songQuery: string,
    durationSec: number | null,
    albumHints: string[]
  ): Promise<RichTrackMeta | null> {
    const albums = new Map<
      string,
      { title: string; token: string; image: string | null; year: string | null }
    >()
    for (const hint of albumHints) {
      const params = new URLSearchParams({
        __call: 'search.getAlbumResults',
        _format: 'json',
        _marker: '0',
        ctx: 'web6dot0',
        cc: 'in',
        q: hint
      })
      const data = (await this.fetchJson(
        `https://www.jiosaavn.com/api.php?${params.toString()}`
      )) as {
        results?: Array<{ title?: string; perma_url?: string; image?: string; year?: string | number }>
      } | null
      for (const a of data?.results ?? []) {
        const title = decodeHtmlEntities(a.title ?? '')
        const token = (a.perma_url ?? '').split('/').filter(Boolean).pop() ?? ''
        if (!title || !token) continue
        const t = normalizePhrase(title)
        const h = normalizePhrase(hint)
        // Only albums plausibly related to the hint (containment either way
        // or a strong token overlap) — "We Love Yuvan" must not be fetched
        // for the "Boss" movie just because a hint reads "yuvan shankar raja".
        if (!(t.includes(h) || h.includes(t) || titleTokenOverlap(hint, title) >= 0.5)) continue
        if (!albums.has(token)) {
          albums.set(token, { title, token, image: a.image ?? null, year: a.year != null ? String(a.year) : null })
        }
      }
      if (albums.size >= 3) break
    }
    let best: ScoredCandidate<RichTrackMeta> | null = null
    for (const album of albums.values()) {
      const params = new URLSearchParams({
        __call: 'webapi.get',
        _format: 'json',
        _marker: '0',
        ctx: 'web6dot0',
        cc: 'in',
        token: album.token,
        type: 'album',
        includeMetaTags: '1'
      })
      const data = (await this.fetchJson(
        `https://www.jiosaavn.com/api.php?${params.toString()}`
      )) as {
        songs?: Array<{
          title?: string
          song?: string
          duration?: string | number
          singers?: string
          primary_artists?: string
          music?: string
          image?: string
        }>
      } | null
      const songs = Array.isArray(data?.songs) ? data.songs : []
      // Re-release editions list songs twice ("Boss n' Baskaran OST" has each
      // song twice); dedupe so track numbers stay unique and in album order.
      const seen = new Set<string>()
      const unique: Array<{ song: (typeof songs)[number]; no: number }> = []
      for (const s of songs) {
        const key = `${normalizePhrase(decodeHtmlEntities(s.title ?? s.song ?? ''))}|${s.duration ?? ''}`
        if (seen.has(key)) continue
        seen.add(key)
        unique.push({ song: s, no: unique.length + 1 })
      }
      for (const { song: s, no } of unique) {
        const title = decodeHtmlEntities(s.title ?? s.song ?? '')
        if (!title) continue
        // The song query must name the track (equality or containment); the
        // album tier exists to confirm the video's song from its movie's
        // tracklist — never to replace it with a same-album neighbour whose
        // duration happens to be close ("Pesadhe" must not become
        // "Dheivam (Version 1)").
        if (candidateNameScore(songQuery, title, s.singers || s.primary_artists) < 0.9) continue
        const durSec = s.duration != null && Number(s.duration) > 0 ? Math.round(Number(s.duration)) : null
        // The matched album is the movie's own edition: pass the hint so the
        // duration veto is relaxed for edits (delta ≤ 90s) exactly like the
        // song-tier rescue.
        const albumHint = albumHints[0] ?? ''
        const meta: RichTrackMeta = {
          provider: 'jiosaavn',
          title: stripLabelTag(title),
          artist: decodeHtmlEntities(s.singers || s.primary_artists || ''),
          album: stripLabelTag(album.title),
          genres: [],
          coverUrl: s.image || album.image,
          durationSec: durSec,
          year: album.year ? Number(album.year) || null : null,
          composer: s.music ? decodeHtmlEntities(s.music) : null,
          trackNo: no
        }
        const cand: ScoredCandidate<RichTrackMeta> = {
          item: meta,
          score: adjustAlbumScore(
            scoreCandidate(
              title,
              durSec != null ? durSec * 1000 : null,
              songQuery,
              durationSec,
              meta.artist,
              albumHint
            ),
            album.title,
            albumHint,
            title,
            songQuery
          ),
          delta:
            durationSec != null && durSec != null ? Math.abs(durSec - durationSec) : null
        }
        best = pickBest(best, cand)
      }
    }
    if (!best || best.score < 0.55) return null
    return best.item
  }

  /** Deezer public API fallback — anonymous, generous rate limits. */
  private async searchDeezerTrack(
    query: string,
    durationSec: number | null,
    albumHints: string[]
  ): Promise<RichTrackMeta | null> {
    const params = new URLSearchParams({ q: query, limit: '10' })
    const data = (await this.fetchJson(`https://api.deezer.com/search?${params.toString()}`)) as {
      data?: Array<{
        title?: string
        duration?: number
        track_position?: number
        artist?: { name?: string }
        album?: { title?: string; cover_xl?: string }
        release_date?: string
      }>
    } | null
    const items = data?.data ?? []
    if (items.length === 0) return null
    let best: ScoredCandidate<(typeof items)[number]> | null = null
    for (const r of items) {
      if (!r.title) continue
      const durSec = r.duration && r.duration > 0 ? Math.round(r.duration) : null
      const album = r.album?.title ?? null
      const albumHint = albumHints.find((h) => normalizePhrase(album ?? '').includes(h)) ?? ''
      const cand: ScoredCandidate<(typeof items)[number]> = {
        item: r,
        score: adjustAlbumScore(
          scoreCandidate(
            r.title,
            r.duration && r.duration > 0 ? r.duration * 1000 : null,
            query,
            durationSec,
            r.artist?.name,
            albumHint
          ),
          album,
          albumHint,
          r.title,
          query
        ),
        delta:
          durationSec != null && durSec != null
            ? Math.abs(durSec - durationSec)
            : null
      }
      best = pickBest(best, cand)
    }
    if (!best || best.score < 0.55) return null
    return {
      provider: 'deezer',
      title: best.item.title as string,
      artist: best.item.artist?.name ?? '',
      album: best.item.album?.title ?? null,
      genres: [],
      coverUrl: best.item.album?.cover_xl ?? null,
      durationSec: best.item.duration ? Math.round(best.item.duration) : null,
      year: best.item.release_date ? Number(best.item.release_date.slice(0, 4)) || null : null,
      trackNo: best.item.track_position != null ? Number(best.item.track_position) : null
    }
  }

  /** iTunes Search API fallback (no credentials required). */
  private async searchItunesTrack(
    query: string,
    durationSec: number | null,
    albumHints: string[]
  ): Promise<RichTrackMeta | null> {
    const params = new URLSearchParams({ term: query, media: 'music', entity: 'song', limit: '10' })
    const data = (await this.fetchJson(`https://itunes.apple.com/search?${params.toString()}`)) as {
      results?: Array<{
        trackName?: string
        artistName?: string
        collectionName?: string
        primaryGenreName?: string
        artworkUrl100?: string
        trackTimeMillis?: number
        trackNumber?: number
        releaseDate?: string
      }>
    } | null
    const items = data?.results ?? []
    if (items.length === 0) {
      getLogger().debug(`itunes search "${query}" -> no results (duration ${durationSec})`)
      return null
    }
    let best: ScoredCandidate<(typeof items)[number]> | null = null
    for (const r of items) {
      if (!r.trackName) continue
      const durSec = r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : null
      const album = r.collectionName ?? null
      const albumHint = albumHints.find((h) => normalizePhrase(album ?? '').includes(h)) ?? ''
      const cand: ScoredCandidate<(typeof items)[number]> = {
        item: r,
        score: adjustAlbumScore(
          scoreCandidate(
            r.trackName,
            r.trackTimeMillis ?? null,
            query,
            durationSec,
            r.artistName,
            albumHint
          ),
          album,
          albumHint,
          r.trackName,
          query
        ),
        delta:
          durationSec != null && durSec != null
            ? Math.abs(durSec - durationSec)
            : null
      }
      best = pickBest(best, cand)
    }
    getLogger().debug(
      `itunes search "${query}" -> ${items.length} results, best="${best?.item.trackName}" score=${best?.score.toFixed(2)}`
    )
    if (!best || best.score < 0.55) return null
    const bestItem = best.item
    return {
      provider: 'itunes',
      title: stripLabelTag(bestItem.trackName as string),
      artist: bestItem.artistName ?? '',
      album: bestItem.collectionName ? stripLabelTag(bestItem.collectionName) : null,
      genres: bestItem.primaryGenreName ? [bestItem.primaryGenreName] : [],
      coverUrl: bestItem.artworkUrl100?.replace('100x100bb.jpg', '600x600bb.jpg') ?? null,
      durationSec: bestItem.trackTimeMillis ? Math.round(bestItem.trackTimeMillis / 1000) : null,
      year: bestItem.releaseDate ? Number(bestItem.releaseDate.slice(0, 4)) || null : null,
      trackNo: bestItem.trackNumber != null ? Number(bestItem.trackNumber) : null
    }
  }

  /**
   * Download cover art and normalize it to JPEG (YouTube/Spotify serve WebP,
   * which the mp4/m4a muxer rejects for attached pictures). Tries each
   * candidate URL in order (catalog art, then YouTube thumbnail variants —
   * maxresdefault.jpg does not exist for older videos). Returns the local
   * temp path; the caller removes it after tagging.
   */
  private async prepareCoverArt(urls: Array<string | null | undefined>, videoId: string): Promise<string | null> {
    const ffmpeg = await this.findFfmpeg()
    if (!ffmpeg) return null
    const tried = new Set<string>()
    for (const url of urls) {
      if (!url || tried.has(url)) continue
      tried.add(url)
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        })
        if (!res.ok) {
          getLogger().debug(`cover fetch ${res.status} for ${url}`)
          continue
        }
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.length === 0) continue
        const coverPath = path.join(os.tmpdir(), 'cyttos-youtube', `${videoId}-cover.jpg`)
        try {
          fs.mkdirSync(path.dirname(coverPath), { recursive: true })
        } catch {
          // ignore
        }
        fs.writeFileSync(coverPath, buf)
        const sig = buf.length >= 4 ? buf.readUInt32BE(0) : 0
        if (sig === 0x52494646) {
          const jpgPath = `${coverPath}.jpg`
          const conv = await new Promise<boolean>((resolve) => {
            execFile(
              ffmpeg,
              ['-y', '-hide_banner', '-loglevel', 'error', '-i', coverPath, '-c:v', 'mjpeg', '-q:v', '3', jpgPath],
              { timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 },
              (err) => resolve(!err)
            )
          })
          if (conv && fs.existsSync(jpgPath)) {
            try {
              fs.rmSync(coverPath, { force: true })
            } catch {
              // ignore
            }
            return jpgPath
          }
        }
        return coverPath
      } catch {
        // try the next candidate
      }
    }
    return null
  }

  // -------------------------------------------------------------------------
  // YouTube stream resolution (internal audio playback)
  // -------------------------------------------------------------------------

  private streamCache = new Map<string, { urls: string[]; expires: number }>()
  private videoMetaCache = new Map<
    string,
    { title: string; channel: string | null; thumbnail: string | null; expires: number }
  >()
  private videoQualityCache = new Map<
    string,
    VideoQualitySet & { expires: number }
  >()

  /**
   * Resolve playable audio stream URLs for a YouTube video without any API
   * credentials. Uses the bundled yt-dlp binary in the main process (the
   * Innertube API requires PO tokens which yt-dlp handles internally) and
   * caches the result briefly; URLs are fed straight into the renderer's
   * audio element, which supports the formats natively. All available
   * qualities/formats are returned (best first) so the player can fall back
   * when a given stream cannot be played.
   */
  async resolveYouTubeStream(videoId: string): Promise<string[]> {
    if (!videoId) return []
    const cached = this.streamCache.get(videoId)
    if (cached && cached.expires > Date.now()) return cached.urls
    try {
      const urls = await this.sdlpYtStreams(videoId)
      if (urls.length === 0) {
        getLogger().info(`No audio stream available for ${videoId}`)
        return []
      }
      getLogger().info(
        `YouTube streams resolved for ${videoId}: ${urls.length} urls (${urls[0].slice(0, 70)}…)`
      )
      // YouTube stream URLs are only valid for a short while; a 15 minute
      // cache keeps repeat plays instant while staying inside that window.
      this.streamCache.set(videoId, { urls, expires: Date.now() + 15 * 60_000 })
      return urls
    } catch (err) {
      getLogger().debug(`YouTube stream resolution failed for ${videoId}`, err)
      return []
    }
  }

  /** Run yt-dlp and return every playable audio URL, best quality first. */
  private async sdlpYtStreams(videoId: string): Promise<string[]> {
    const stdout = await this.runYtdlp([
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
      '--skip-download',
      '-j',
      `https://www.youtube.com/watch?v=${videoId}`
    ])
    if (!stdout) return []
    return extractStreamUrls(stdout)
  }

  /**
   * Last-resort playback: download the track's audio with yt-dlp to a local
   * temp file and return its path. Works for EVERY audio format YouTube
   * offers (opus webm, m4a, …) no matter what the streamed URLs support, so
   * any kind/version of audio can always be played. Downloaded files are
   * cached in memory for the session and served through the local protocol
   * (the same pipeline that plays library files).
   */
  private ytDownloads = new Map<string, string>()

  /** Live yt-dlp download children keyed by videoId, so cancel/remove can kill them instantly. */
  private ytChildren = new Map<string, ChildProcess>()

  /** True while a yt-dlp child for the video is still alive. */
  isYtChildRunning(videoId: string): boolean {
    const c = this.ytChildren.get(videoId)
    return Boolean(c && c.exitCode === null)
  }

  /** Kill a running yt-dlp download for a video immediately (no 500ms poll). */
  forceKillYtChild(videoId: string): void {
    const child = this.ytChildren.get(videoId)
    if (child) {
      try {
        child.kill()
      } catch {
        // ignore
      }
    }
  }

  /** Resolve once the yt-dlp child for a video has actually exited (or after maxWaitMs). */
  whenYtChildGone(videoId: string, maxWaitMs: number): Promise<void> {
    const child = this.ytChildren.get(videoId)
    if (!child || child.exitCode !== null) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      const started = Date.now()
      const iv = setInterval(() => {
        const c = this.ytChildren.get(videoId)
        if (!c || c.exitCode !== null || Date.now() - started >= maxWaitMs) {
          clearInterval(iv)
          resolve()
        }
      }, 100)
      iv.unref?.()
    })
  }

  async downloadYouTubeAudio(videoId: string): Promise<string | null> {
    if (!videoId) return null
    const cached = this.ytDownloads.get(videoId)
    if (cached && fs.existsSync(cached)) return cached
    const exe = this.ytdlpBin()
    if (!exe) {
      getLogger().debug('yt-dlp binary not found')
      return null
    }
    const dir = path.join(os.tmpdir(), 'cyttos-youtube')
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      return null
    }
    const pattern = `${videoId}.`
    const output = path.join(dir, `${videoId}.%(ext)s`)
    // Transient network/YouTube hiccups (bot checks, rate limits, …) are
    // common mid-session; retry a few times before giving up.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        getLogger().debug(`retrying YouTube audio download for ${videoId} (attempt ${attempt + 1})`)
        await new Promise((r) => setTimeout(r, 1500 * attempt))
      }
      const file = await this.execYtAudioDownload(exe, videoId, dir, pattern, output)
      if (file) return file
    }
    return null
  }

  private execYtAudioDownload(
    exe: string,
    videoId: string,
    dir: string,
    pattern: string,
    output: string
  ): Promise<string | null> {
    // Stale partial files left by interrupted attempts would short-circuit
    // the readdir check below; clear them before every attempt.
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (name.startsWith(pattern)) {
        try {
          fs.rmSync(path.join(dir, name), { force: true })
        } catch {
          // ignore
        }
      }
    }
    return new Promise((resolve) => {
      execFile(
        exe,
        [
          ...YT_CLIENT_ARGS,
          '--no-playlist',
          '--no-warnings',
          '--no-progress',
          '--no-call-home',
          '-f',
          'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio[ext=opus]/bestaudio/best',
          '-o',
          output,
          `https://www.youtube.com/watch?v=${videoId}`
        ],
        { timeout: 300_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (err) => {
          if (err) {
            getLogger().warn(`yt-dlp audio download failed for ${videoId}: ${err.message}`, err)
            resolve(null)
            return
          }
          try {
            const name = fs.readdirSync(dir).find((n) => n.startsWith(pattern))
            if (!name) {
              resolve(null)
              return
            }
            const file = path.join(dir, name)
            this.ytDownloads.set(videoId, file)
            getLogger().info(`YouTube audio downloaded for ${videoId}: ${file}`)
            resolve(file)
          } catch {
            resolve(null)
          }
        }
      )
    })
  }

  /**
   * Download a video WITH its audio via yt-dlp. Best quality is used and,
   * when ffmpeg is available, the separate best video + best audio streams
   * are merged into a single MP4 (fixes "no audio" downloads of 1080p
   * video-only DASH). Without ffmpeg it falls back to the best single-file
   * format (muxed, so audio is kept up to 720p). Progress is reported live
   * (percent / bytes / speed / ETA) through `onProgress`, and the download
   * can be aborted mid-flight via `isAborted`.
   */
  async downloadYouTubeVideo(
    videoId: string,
    destDir: string,
    opts: YouTubeDownloadOptions = {}
  ): Promise<string | null> {
    if (!videoId) return null
    const exe = this.ytdlpBin()
    if (!exe) return null
    try {
      fs.mkdirSync(destDir, { recursive: true })
    } catch {
      return null
    }
    const output = path.join(destDir, `%(title)s [${videoId}].%(ext)s`)
    const ffmpeg = await this.findFfmpeg()
    const audioSel =
      opts.audio === 'm4a' ? 'ba[ext=m4a]/ba' : opts.audio === 'opus' ? 'ba[ext=webm]/ba' : 'ba'
    const args = [
      ...YT_CLIENT_ARGS,
      '--no-playlist',
      '--no-warnings',
      '--no-colors',
      '--no-call-home',
      '--newline',
      '--progress-template',
      'download:dlp:%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.speed_str)s|%(progress.eta_str)s',
      '-o',
      output
    ]
    if (ffmpeg) {
      // `bv*+ba` selects the best video-only DASH + best audio and merges
      // them with ffmpeg into a single MP4.  Without a height cap
      // (height=0) the first choice is simply `bv*+ba`; with a cap it
      // becomes `bv*[height<=1080]+ba`.  The trailing fallbacks cover
      // cases where DASH is unavailable (e.g. live streams) — `bv*` is a
      // muxed single file with both streams, and `b` is any best file.
      const heightPart = opts.height && opts.height > 0 ? `[height<=${opts.height}]` : ''
      args.push('-f', `bv*${heightPart}+${audioSel}/bv*+${audioSel}/bv*/b`)
      args.push('--merge-output-format', 'mp4')
      if (ffmpeg !== 'ffmpeg') args.push('--ffmpeg-location', path.dirname(ffmpeg))
    } else {
      // Without ffmpeg only single-file formats work (muxed video+audio).
      // `b` is the absolute best single file (muxed up to 720p on YouTube);
      // `bv*` selects muxed-only as a narrower fallback.
      args.push('-f', 'bv*/b')
    }
    args.push(`https://www.youtube.com/watch?v=${videoId}`)
    return new Promise((resolve) => {
      const child = spawn(exe, args, { windowsHide: true })
      this.ytChildren.set(videoId, child)
      let stdout = ''
      let lastBytes = 0
      let lastBytesAt = Date.now()
      let emaSpeed = 0
      const onLine = (line: string): void => {
        const m = /^dlp:\s*([\d.]+)%\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)$/.exec(line.trim())
        if (!m) return
        const percent = clampNum(Number(m[1]), 0, 100)
        const bytes = Number(m[2]) || 0
        // yt-dlp often prints NA for speed; derive it from byte deltas (EMA)
        // so the Downloads row always shows a live rate.
        const now = Date.now()
        if (bytes > lastBytes) {
          const dt = Math.max(0.3, (now - lastBytesAt) / 1000)
          const inst = (bytes - lastBytes) / dt
          emaSpeed = emaSpeed > 0 ? emaSpeed * 0.7 + inst * 0.3 : inst
          lastBytes = bytes
          lastBytesAt = now
        }
        const total = Number(m[3]) || 0
        opts.onProgress?.(percent, bytes, total, Math.round(emaSpeed), parseEta(m[5]))
      }
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
        for (const line of stdout.split(/\r?\n/)) onLine(line)
        stdout = stdout.slice(stdout.lastIndexOf('\n') + 1)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
        for (const line of stdout.split(/\r?\n/)) onLine(line)
        stdout = stdout.slice(stdout.lastIndexOf('\n') + 1)
      })
      const abortIv = setInterval(() => {
        if (opts.isAborted?.()) {
          try {
            child.kill()
          } catch {
            // ignore
          }
        } else if (Date.now() - lastBytesAt > 90_000) {
          getLogger().warn(`yt-dlp video download stalled for ${videoId}; killing`)
          try {
            child.kill()
          } catch {
            // ignore
          }
        }
      }, 500)
      child.on('error', (err) => {
        clearInterval(abortIv)
        this.ytChildren.delete(videoId)
        getLogger().warn(`yt-dlp video download failed for ${videoId}: ${err.message}`, err)
        resolve(null)
      })
      child.on('close', (code) => {
        clearInterval(abortIv)
        this.ytChildren.delete(videoId)
        if (code !== 0 || opts.isAborted?.()) {
          if (code !== 0) {
            getLogger().warn(`yt-dlp video download exited ${code} for ${videoId}`)
          }
          resolve(null)
          return
        }
        try {
          const files = fs
            .readdirSync(destDir)
            .filter(
              (n) =>
                n.includes(videoId) &&
                !n.endsWith('.part') &&
                !n.endsWith('.ytdl') &&
                !n.includes('[unknown]')
            )
            .sort(
              (a, b) =>
                fs.statSync(path.join(destDir, b)).mtimeMs -
                fs.statSync(path.join(destDir, a)).mtimeMs
            )
          resolve(files.length > 0 ? path.join(destDir, files[0]) : null)
        } catch {
          resolve(null)
        }
      })
    })
  }

  /**
   * Download a YouTube video's BEST AUDIO as a single file (no video stream,
   * no merge). Used by "Download song" so the result is a manageable audio
   * file that can then be tagged with cover art + metadata. Progress is
   * reported exactly like video downloads.
   */
  async downloadYouTubeAudioFile(
    videoId: string,
    destDir: string,
    opts: YouTubeDownloadOptions = {}
  ): Promise<string | null> {
    if (!videoId) return null
    const exe = this.ytdlpBin()
    if (!exe) return null
    try {
      fs.mkdirSync(destDir, { recursive: true })
    } catch {
      return null
    }
    const output = path.join(destDir, `%(title)s [${videoId}].%(ext)s`)
    // Songs land as .m4a whenever the video has an AAC stream: MP4 carries
    // embedded cover art + full tags, which is what "Download song" promises.
    // Opus/webm only gets picked when no m4a exists at all.
    const audioSel =
      opts.audio === 'opus' ? 'ba[ext=webm]/ba' : 'ba[ext=m4a]/ba'
    const args = [
      ...YT_CLIENT_ARGS,
      '--no-playlist',
      '--no-warnings',
      '--no-colors',
      '--no-call-home',
      '--newline',
      '--progress-template',
      'download:dlp:%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.speed_str)s|%(progress.eta_str)s',
      '-f',
      audioSel,
      '-o',
      output,
      `https://www.youtube.com/watch?v=${videoId}`
    ]
    return new Promise((resolve) => {
      const child = spawn(exe, args, { windowsHide: true })
      this.ytChildren.set(videoId, child)
      let stdout = ''
      let lastBytes = 0
      let lastBytesAt = Date.now()
      let emaSpeed = 0
      const onLine = (line: string): void => {
        const m = /^dlp:\s*([\d.]+)%\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)$/.exec(line.trim())
        if (!m) return
        const percent = clampNum(Number(m[1]), 0, 100)
        const bytes = Number(m[2]) || 0
        const now = Date.now()
        if (bytes > lastBytes) {
          const dt = Math.max(0.3, (now - lastBytesAt) / 1000)
          const inst = (bytes - lastBytes) / dt
          emaSpeed = emaSpeed > 0 ? emaSpeed * 0.7 + inst * 0.3 : inst
          lastBytes = bytes
          lastBytesAt = now
        }
        const total = Number(m[3]) || 0
        opts.onProgress?.(percent, bytes, total, Math.round(emaSpeed), parseEta(m[5]))
      }
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
        for (const line of stdout.split(/\r?\n/)) onLine(line)
        stdout = stdout.slice(stdout.lastIndexOf('\n') + 1)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
        for (const line of stdout.split(/\r?\n/)) onLine(line)
        stdout = stdout.slice(stdout.lastIndexOf('\n') + 1)
      })
      const abortIv = setInterval(() => {
        if (opts.isAborted?.()) {
          try {
            child.kill()
          } catch {
            // ignore
          }
        } else if (Date.now() - lastBytesAt > 90_000) {
          getLogger().warn(`yt-dlp audio download stalled for ${videoId}; killing`)
          try {
            child.kill()
          } catch {
            // ignore
          }
        }
      }, 500)
      child.on('error', (err) => {
        clearInterval(abortIv)
        this.ytChildren.delete(videoId)
        getLogger().warn(`yt-dlp audio download failed for ${videoId}: ${err.message}`, err)
        resolve(null)
      })
      child.on('close', (code) => {
        clearInterval(abortIv)
        this.ytChildren.delete(videoId)
        if (code !== 0 || opts.isAborted?.()) {
          if (code !== 0) {
            getLogger().warn(`yt-dlp audio download exited ${code} for ${videoId}`)
          }
          resolve(null)
          return
        }
        try {
          const files = fs
            .readdirSync(destDir)
            .filter(
              (n) =>
                n.includes(videoId) &&
                !n.endsWith('.part') &&
                !n.endsWith('.ytdl') &&
                !n.includes('[unknown]')
            )
            .sort(
              (a, b) =>
                fs.statSync(path.join(destDir, b)).mtimeMs -
                fs.statSync(path.join(destDir, a)).mtimeMs
            )
          resolve(files.length > 0 ? path.join(destDir, files[0]) : null)
        } catch {
          resolve(null)
        }
      })
    })
  }

  /**
   * Embed title/artist/album tags plus cover art into a downloaded audio
   * file (best-effort; keeps everything with `-c copy`, so no re-encode).
   * Cover is the video thumbnail; artist is the channel name.
   */
  async tagYouTubeAudioFile(
    filePath: string,
    videoId: string,
    meta: TrackTagInput | null
  ): Promise<string | null> {
    if (!filePath || !fs.existsSync(filePath)) return null
    const ffmpeg = await this.findFfmpeg()
    if (!ffmpeg) {
      getLogger().debug('ffmpeg unavailable; skipping audio tagging')
      return filePath
    }
    // Prefer the music-catalog cover, then the YouTube thumbnail, then the
    // standard thumbnail sizes (maxresdefault does not exist for older
    // videos, so the chain walks down to hq/mq). All get normalized to JPEG.
    const coverPath = await this.prepareCoverArt(
      [
        meta?.coverUrl,
        meta?.thumbnail,
        `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
        `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
      ],
      videoId
    )
    const title = meta?.title?.slice(0, 160) ?? ''
    const artist = (meta?.artist ?? meta?.channel)?.slice(0, 120) ?? ''
    const album = (meta?.album ?? artist)?.slice(0, 160) ?? ''
    const composer = (meta?.composer || composerFromTitle(meta?.title ?? '', artist))?.slice(0, 80) ?? ''
    // WebM/opus cannot embed cover art (ffmpeg's webm muxer rejects attached
    // pictures); tags still work, so tag-only is applied for those files.
    const isWebm = filePath.toLowerCase().endsWith('.webm')
    const tmpExt = path.extname(filePath) || '.m4a'
    const tmpPath = `${filePath}.tagged${tmpExt}`
    try {
      if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true })
    } catch {
      // ignore
    }
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', filePath]
    if (coverPath && !isWebm) args.push('-i', coverPath)
    if (coverPath && !isWebm) {
      // `-map 0` would copy every previously embedded cover from earlier
      // tagging passes into the new file, stacking attached pictures (players
      // always show the first, so a re-fix would never replace the art).
      args.push('-map', '0:a', '-map', '1')
    } else {
      args.push('-map', '0')
    }
    args.push('-c', 'copy')
    if (title) args.push('-metadata', `title=${title}`)
    if (artist) {
      args.push('-metadata', `artist=${artist}`)
      args.push('-metadata', `album=${album}`)
    }
    // Always write the composer tag (empty when unknown) so a previous wrong
    // value ("Sai Pallavi" from a cast-name guess) is cleared on re-fix.
    args.push('-metadata', `composer=${composer}`)
    for (const g of (meta?.genres ?? []).slice(0, 2)) {
      if (g.trim()) args.push('-metadata', `genre=${g.trim().slice(0, 60)}`)
    }
    if (meta?.year) args.push('-metadata', `date=${meta.year}`)
    if (meta?.trackNo != null && meta.trackNo > 0) {
      args.push('-metadata', `track=${meta.trackNo}`)
    }
    if (coverPath && !isWebm) {
      args.push(
        '-metadata:s:v',
        'title=Album art',
        '-metadata:s:v',
        'comment=Cover (front)',
        '-disposition:v',
        'attached_pic'
      )
    }
    args.push(tmpPath)
    const runTag = (flags: string[] = []): Promise<boolean> => {
      const finalArgs = flags.length ? [...args.slice(0, -1), ...flags, tmpPath] : args
      return new Promise((resolve) => {
        execFile(
          ffmpeg,
          finalArgs,
          { timeout: 90_000, windowsHide: true, maxBuffer: 1024 * 1024 },
          (err) => {
            if (err) {
              getLogger().warn(`audio tagging failed for ${videoId}: ${err.message}`)
              resolve(false)
              return
            }
            resolve(true)
          }
        )
      })
    }
    let ok = await runTag()
    // Some YouTube songs are E-AC3 in m4a; the default (ipod) m4a muxer
    // rejects eac3, so retry with the generic mp4 muxer (still `-c copy`).
    if (!ok && !isWebm && tmpExt === '.m4a') {
      try {
        if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true })
      } catch {
        // ignore
      }
      ok = await runTag(['-f', 'mp4'])
    }
    try {
      if (coverPath && fs.existsSync(coverPath)) fs.rmSync(coverPath, { force: true })
    } catch {
      // ignore
    }
    if (!ok || !fs.existsSync(tmpPath)) {
      try {
        if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true })
      } catch {
        // ignore
      }
      return null
    }
    try {
      // The original file is ours (yt-dlp exited before we got here), so a
      // plain move is safe on Windows.
      if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true })
      fs.renameSync(tmpPath, filePath)
      return filePath
    } catch (err) {
      getLogger().warn(`tagged file replace failed for ${videoId}`, err)
      try {
        if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true })
      } catch {
        // ignore
      }
      return null
    }
  }

  /** Video title for a YouTube id (cached briefly; used for download rows). */
  async getYouTubeTitle(videoId: string): Promise<string | null> {
    const meta = await this.getYouTubeMeta(videoId)
    return meta?.title ?? null
  }

  /** Rich, cached metadata for a YouTube id (title, channel, thumbnail). */
  async getYouTubeMeta(
    videoId: string
  ): Promise<{ title: string; channel: string | null; thumbnail: string | null } | null> {
    if (!videoId) return null
    const cached = this.videoMetaCache.get(videoId)
    if (cached && cached.expires > Date.now()) {
      return { title: cached.title, channel: cached.channel, thumbnail: cached.thumbnail }
    }
    const exe = this.ytdlpBin()
    if (!exe) return null
    return new Promise((resolve) => {
      execFile(
        exe,
        [
          ...YT_CLIENT_ARGS,
          '--no-playlist',
          '--no-warnings',
          '--skip-download',
          '-j',
          `https://www.youtube.com/watch?v=${videoId}`
        ],
        { timeout: 30_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => {
          if (err) {
            resolve(null)
            return
          }
          try {
            const info = JSON.parse(stdout) as {
              title?: string
              channel?: string
              thumbnail?: { url?: string }
              thumbnails?: Array<{ url: string }>
            }
            const title = info.title ? String(info.title).slice(0, 160) : null
            if (!title) {
              resolve(null)
              return
            }
            const channel = info.channel?.slice(0, 120) ?? null
            const thumbnail =
              info.thumbnail?.url ??
              info.thumbnails?.[info.thumbnails.length - 1]?.url ??
              null
            this.videoMetaCache.set(videoId, { title, channel, thumbnail, expires: Date.now() + 60 * 60_000 })
            resolve({ title, channel, thumbnail })
          } catch {
            resolve(null)
          }
        }
      )
    })
  }

  /**
   * Audio-fingerprint fallback for files whose text-based metadata lookup
   * found nothing: Chromaprint the file with ffmpeg, submit the fingerprint
   * to AcoustID, and map the best recording to rich metadata. Returns null
   * when no API key is set, the file can't be fingerprinted, or no match
   * clears the confidence threshold.
   */
  async lookupByFingerprint(
    filePath: string,
    durationSec: number | null,
    config: ProviderConfig
  ): Promise<RichTrackMeta | null> {
    if (!config.acoustidApiKey) {
      getLogger().debug('acoustid: no API key configured — skipping fingerprint lookup')
      return null
    }
    const ffmpeg = await this.findFfmpeg()
    if (!ffmpeg) return null
    const fingerprint = await this.chromaprint(ffmpeg, filePath)
    if (!fingerprint) return null
    const params = new URLSearchParams({
      client: config.acoustidApiKey,
      duration: String(durationSec ?? 0),
      fingerprint,
      meta: 'recordings+releasegroups+releases+compress'
    })
    const data = (await this.fetchJson(
      `https://api.acoustid.org/v2/lookup?${params.toString()}`
    )) as {
      status?: string
      results?: Array<{
        id: string
        score?: number
        recordings?: Array<{
          id: string
          title?: string
          artists?: Array<{ id: string; name?: string }>
          duration?: number
          releasegroups?: Array<{
            id: string
            title?: string
            releases?: Array<{ id?: string; date?: { year?: number; month?: number; day?: number } }>
          }>
        }>
      }>
    } | null
    if (!data || data.status !== 'ok') {
      getLogger().debug(`acoustid: lookup failed (${data?.status ?? 'no response'})`)
      return null
    }
    const rec = data.results?.[0]?.recordings?.find((r) => r.title)
    if (!rec?.title) {
      getLogger().debug('acoustid: no recording match')
      return null
    }
    const rg = rec.releasegroups?.[0]
    const release = rg?.releases?.find((r) => r.id)
    const date = release?.date
    return {
      provider: 'acoustid',
      title: rec.title,
      artist:
        rec.artists?.map((a) => a.name).filter(Boolean).join(', ') || 'Unknown Artist',
      album: rg?.title ?? null,
      genres: [],
      coverUrl: release?.id
        ? `https://coverartarchive.org/release/${release.id}/front-500`
        : null,
      durationSec: rec.duration ?? null,
      year: date?.year ?? null,
      composer: null
    }
  }

  /**
   * Base64 Chromaprint of an audio file via ffmpeg's built-in chromaprint
   * muxer (no external library needed). Returns null when ffmpeg can't
   * fingerprint (unsupported codec, corrupted file, etc.).
   */
  private chromaprint(ffmpeg: string, filePath: string): Promise<string | null> {
    return new Promise((resolve) => {
      const proc = spawn(
        ffmpeg,
        ['-hide_banner', '-loglevel', 'error', '-i', filePath, '-f', 'chromaprint', '-fp_format', 'base64', '-'],
        { windowsHide: true }
      )
      const chunks: Buffer[] = []
      const timer = setTimeout(() => {
        proc.kill()
        resolve(null)
      }, 180_000)
      proc.stdout.on('data', (c: Buffer) => chunks.push(c))
      proc.on('error', () => {
        clearTimeout(timer)
        resolve(null)
      })
      proc.on('close', (code) => {
        clearTimeout(timer)
        if (code !== 0) {
          getLogger().debug(`chromaprint failed for ${filePath} (exit ${code})`)
          resolve(null)
          return
        }
        const fp = Buffer.concat(chunks).toString('utf8').trim()
        resolve(fp.length > 0 ? fp : null)
      })
    })
  }

  private async findFfmpeg(): Promise<string | null> {
    // Winget-installed ffmpeg (e.g. the one bundled with yt-dlp.FFmpeg).
    const localAppData = process.env.LOCALAPPDATA
    if (localAppData) {
      const base = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages')
      try {
        const candidates: string[] = []
        for (const pkg of fs.readdirSync(base)) {
          if (!pkg.toLowerCase().includes('ffmpeg')) continue
          const pkgDir = path.join(base, pkg)
          try {
            for (const ver of fs.readdirSync(pkgDir)) {
              const bin = path.join(pkgDir, ver, 'bin', 'ffmpeg.exe')
              if (fs.existsSync(bin)) candidates.push(bin)
            }
          } catch {
            // ignore
          }
        }
        for (const c of candidates) {
          if (await isFfmpegBinary(c)) return c
        }
      } catch {
        // ignore
      }
    }
    if (await isFfmpegBinary('ffmpeg')) return 'ffmpeg'
    return null
  }

  /**
   * Resolve playable audio stream URLs for multiple YouTube videos in one
   * batch call. Used by "Play playlist" so the player can queue every track
   * without N separate IPC round-trips.
   */
  async resolveYouTubeStreamBatch(
    videoIds: string[]
  ): Promise<Array<{ videoId: string; urls: string[] }>> {
    const results: Array<{ videoId: string; urls: string[] }> = []
    const BATCH = 4
    for (let i = 0; i < videoIds.length; i += BATCH) {
      const slice = videoIds.slice(i, i + BATCH)
      const settled = await Promise.allSettled(
        slice.map(async (id) => {
          const urls = await this.resolveYouTubeStream(id)
          return { videoId: id, urls }
        })
      )
      for (let j = 0; j < settled.length; j++) {
        const s = settled[j]
        if (s.status === 'fulfilled') results.push(s.value)
        else results.push({ videoId: slice[j], urls: [] })
      }
    }
    return results
  }

  /**
   * Run yt-dlp and return stdout. First attempt uses the embed-player client
   * flags (bypasses the IP-wide bot check); if that fails (e.g. the video
   * has embedding disabled) it retries once with the default client.
   * Failures are logged at info level so resolution problems are visible
   * in the app log.
   */
  private async runYtdlp(args: string[], timeoutMs = 45_000): Promise<string | null> {
    const exe = this.ytdlpBin()
    if (!exe) return null
    const attempts: string[][] = [
      [...YT_CLIENT_ARGS, ...args],
      args
    ]
    for (let attempt = 0; attempt < attempts.length; attempt++) {
      const stdout = await new Promise<string>((resolve) => {
        execFile(
          exe,
          attempts[attempt],
          { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
          (err, out, stderr) => {
            if (err) {
              getLogger().info(`yt-dlp failed (attempt ${attempt + 1}): ${err.message}`, {
                stderr: String(stderr ?? '').slice(0, 400)
              })
              resolve('')
              return
            }
            resolve(String(out ?? ''))
          }
        )
      })
      if (stdout) return stdout
      if (attempt < attempts.length - 1) await sleep(1500)
    }
    return null
  }

  /**
   * Resolve a single direct video URL for the internal video player (no
   * YouTube chrome, no embed restrictions). Prefers a progressive MP4
   * (H.264/AAC) so Chromium plays it natively; falls back to the best
   * available format (e.g. WebM) otherwise.
   */
  async resolveYouTubeVideo(videoId: string): Promise<string | null> {
    if (!videoId) return null
    const stdout = await this.runYtdlp([
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
      '--skip-download',
      '-g',
      '-f',
      'best[ext=mp4][vcodec^=avc1]/best[ext=mp4]/best',
      `https://www.youtube.com/watch?v=${videoId}`
    ])
    if (!stdout) return null
    const first = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.startsWith('http'))
    return first ?? null
  }

  /**
   * Resolve the playable video streams for a YouTube video, grouped by
   * video height (best quality first). Uses a single yt-dlp info dump and
   * picks the best playable format per height: progressive MP4 (H.264 + AAC)
   * first, then HLS manifests (played with hls.js by the video window).
   * Video-only DASH formats (no audio) ARE included per height: YouTube
   * serves 1080p+ only as video-only DASH, so the caller pairs them with
   * the best audio stream (see `audioUrl`). Results are cached briefly
   * because signed stream URLs expire.
   */
  async resolveYouTubeVideoQualities(videoId: string): Promise<VideoQualitySet> {
    if (!videoId) return { streams: [], audioUrl: null }
    const cached = this.videoQualityCache.get(videoId)
    if (cached && cached.expires > Date.now()) return cached
    const stdout = await this.runYtdlp([
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
      '--skip-download',
      '-j',
      `https://www.youtube.com/watch?v=${videoId}`
    ])
    if (!stdout) return { streams: [], audioUrl: null }

    const set: VideoQualitySet | null = (() => {
      try {
        const info = JSON.parse(stdout) as {
          formats?: Array<{
            height?: number
            url?: string
            vcodec?: string
            acodec?: string
            ext?: string
            protocol?: string
          }>
        }
        const formats = Array.isArray(info.formats) ? info.formats : []
        const bestVideo = new Map<
          number,
          { height: number; url: string; score: number; hls: boolean; videoOnly: boolean }
        >()
        let audioUrl: string | null = null
        let audioScore = -1
        for (const fmt of formats) {
          const url = fmt.url
          if (!url) continue
          const isVideo = Boolean(fmt.vcodec && fmt.vcodec !== 'none')
          const hasAudio = Boolean(fmt.acodec && fmt.acodec !== 'none')
          const hls =
            (fmt.protocol && fmt.protocol.startsWith('m3u8')) ||
            /hls_playlist|\.m3u8(?:\?|$)/.test(url)
          if (isVideo && fmt.height) {
            // Video streams: muxed (with audio) or video-only DASH.
            const isDirect = !hls
            const score =
              (isDirect ? 16 : 4) +
              (fmt.ext === 'mp4' ? 4 : 0) +
              (fmt.vcodec && fmt.vcodec.startsWith('avc1') ? 2 : 0)
            const prev = bestVideo.get(fmt.height)
            if (!prev || score > prev.score) {
              bestVideo.set(fmt.height, {
                height: fmt.height,
                url,
                score,
                hls,
                videoOnly: !hasAudio
              })
            }
          } else if (!isVideo && hasAudio) {
            // Audio-only streams: the pairing audio for video-only DASH.
            // MP4/AAC is what Chromium actually plays (WebM/Opus URLs from
            // the web_embedded player are rejected with NotSupportedError).
            const isDirect = !hls
            const score =
              (isDirect ? 16 : 4) +
              (fmt.ext === 'm4a' ? 6 : fmt.ext === 'webm' ? 3 : 1) +
              (fmt.acodec === 'aac' ? 4 : fmt.acodec === 'opus' ? 2 : 0)
            if (score > audioScore) {
              audioScore = score
              audioUrl = url
            }
          }
        }
        return {
          streams: [...bestVideo.values()]
            .sort((a, b) => b.height - a.height)
            .map(({ height, url, hls, videoOnly }) => ({ height, url, hls, videoOnly })),
          audioUrl
        }
      } catch (parseErr) {
        getLogger().info(`yt-dlp quality parse failed for ${videoId}`, parseErr)
        return null
      }
    })()

    if (!set) return { streams: [], audioUrl: null }
    set.fresh = true
    if (set.streams.length > 0) {
      this.videoQualityCache.set(videoId, {
        streams: set.streams,
        audioUrl: set.audioUrl,
        expires: Date.now() + 30 * 60_000
      })
    }
    return set
  }

  /** Locate the yt-dlp binary (project bin/ first, then app resources). */
  private ytdlpBin(): string | null {
    const name = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
    const candidates = [
      path.join(process.cwd(), 'bin', name),
      path.join(__dirname, '../../../bin', name),
      path.join(process.resourcesPath ?? '', 'bin', name)
    ]
    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) return candidate
    }
    return null
  }

  isSpotifyConfigured(config: ProviderConfig): boolean {
    return Boolean(config.spotifyClientId && config.spotifyClientSecret)
  }

  isYouTubeConfigured(_config: ProviderConfig): boolean {
    // YouTube search runs on the bundled yt-dlp binary — no API key needed.
    return true
  }

  status(config: ProviderConfig): ProviderStatus {
    return {
      spotifyConfigured: this.isSpotifyConfigured(config),
      youtubeConfigured: this.isYouTubeConfigured(config)
    }
  }
}

interface YtFormat {
  url?: string
  mimeType?: string
  vcodec?: string | null
  acodec?: string | null
  abr?: number | null
  tbr?: number | null
  /** Container extension as reported by yt-dlp (m4a/webm/mp4/…). */
  ext?: string
}

/**
 * Parse yt-dlp's `-j` output and collect every playable audio URL, ordered by
 * quality: best audio-only formats first, then muxed video+audio formats as a
 * last resort. Manifest URLs (HLS/DASH) are skipped because the renderer's
 * audio element cannot play them.
 */
function extractStreamUrls(stdout: Buffer | string): string[] {
  try {
    const data = JSON.parse(String(stdout)) as { formats?: YtFormat[] }
    const formats = Array.isArray(data.formats) ? data.formats : []
    const seen = new Set<string>()
    const push = (url: string | undefined): void => {
      if (!url || seen.has(url)) return
      const u = url.trim()
      if (!/^https?:\/\//.test(u)) return
      if (/\.m3u8/i.test(u) || /\.mpd/i.test(u)) return
      seen.add(u)
    }
    const quality = (f: YtFormat): number => f.abr ?? f.tbr ?? 0
    const audioOnly = formats.filter(
      (f) => f.vcodec === 'none' && f.acodec && f.acodec !== 'none' && f.url
    )
    const muxed = formats.filter(
      (f) => f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && f.url
    )
    // yt-dlp's format dicts expose the container as `ext` (m4a/webm/mp4/…),
    // not as `mimeType`, so detect MP4/AAC from `ext` (mimeType is unreliable
    // here). Chromium rejects the WebM/Opus streams YouTube signs for the
    // web_embedded player ("no supported source"), while the MP4/AAC stream
    // plays; keep MP4/AAC first and use WebM only as a fallback.
    const isMp4Audio = (f: YtFormat): boolean =>
      f.ext === 'm4a' ||
      f.ext === 'mp4' ||
      /audio\/mp4|audio\/mpeg/i.test(f.mimeType ?? '')
    const byQuality = (a: YtFormat, b: YtFormat): number => quality(b) - quality(a)
    // Chromium rejects the WebM/Opus streams YouTube signs for the
    // web_embedded player ("no supported source"), while the MP4/AAC
    // stream plays; keep MP4/AAC first and use WebM only as a fallback.
    const sortedAudio = [
      ...audioOnly.filter(isMp4Audio).sort(byQuality),
      ...audioOnly.filter((f) => !isMp4Audio(f)).sort(byQuality)
    ]
    sortedAudio.forEach((f) => push(f.url))
    muxed.sort(byQuality).forEach((f) => push(f.url))
    return [...seen]
  } catch {
    return []
  }
}