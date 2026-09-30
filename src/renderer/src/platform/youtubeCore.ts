/**
 * Reading yt-dlp's JSON for the phone app: search results, playlists, stream addresses, and song tags for downloads.
 * The rules are the PC app's (main/services/provider.ts): MP4/AAC audio first, WebM only as a fallback, playlists
 * capped at 2,000 (a Mix at 500), a Mix only opens through one of its videos. Pure functions, tested on real yt-dlp output.
 */
import type { OnlineSearchResult } from '@shared/types'

export { PLAYLIST_LIMIT, MIX_LIMIT, playlistTarget } from '@main/util/playlistUrl'

const VIDEO_ID = /^[\w-]{11}$/

export function isVideoId(s: unknown): s is string {
  return typeof s === 'string' && VIDEO_ID.test(s)
}

/** The video id in any YouTube address (watch, youtu.be, shorts, embed, live, music). */
export function videoIdFromUrl(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  const host = u.hostname.replace(/^(www\.|m\.|music\.)/i, '')
  if (host === 'youtu.be') {
    const id = u.pathname.split('/')[1] ?? ''
    return isVideoId(id) ? id : null
  }
  if (host !== 'youtube.com') return null
  const v = u.searchParams.get('v')
  if (isVideoId(v)) return v
  const m = /^\/(?:shorts|embed|live|v)\/([\w-]{11})(?:[/?]|$)/.exec(u.pathname)
  return m ? m[1] : null
}

export function isYouTubeUrl(raw: string): boolean {
  try {
    const host = new URL(raw.trim()).hostname.replace(/^(www\.|m\.|music\.)/i, '')
    return host === 'youtube.com' || host === 'youtu.be'
  } catch {
    return false
  }
}

const watchUrl = (id: string): string => `https://www.youtube.com/watch?v=${id}`
const thumb = (id: string): string => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`

interface FlatEntry {
  id?: string
  title?: string
  channel?: string
  uploader?: string
  duration?: number
  thumbnails?: Array<{ url?: string }>
}

function firstThumb(e: FlatEntry): string | null {
  return e.thumbnails?.find((t) => t.url)?.url ?? null
}

/** `ytsearchN:` flat listing -> search rows. */
export function parseSearch(stdout: string): OnlineSearchResult[] {
  try {
    const info = JSON.parse(stdout) as { entries?: FlatEntry[] }
    const entries = Array.isArray(info.entries) ? info.entries : []
    return entries
      .filter((e) => isVideoId(e.id) && e.title)
      .map((e) => ({
        provider: 'youtube',
        id: `youtube:${e.id}`,
        title: e.title ?? 'Untitled',
        artist: e.channel ?? e.uploader ?? 'Unknown',
        album: null,
        duration: typeof e.duration === 'number' && e.duration > 0 ? e.duration : null,
        year: null,
        artworkUrl: firstThumb(e) ?? thumb(e.id as string),
        url: watchUrl(e.id as string),
        previewUrl: null,
        videoId: e.id as string
      }))
  } catch {
    return []
  }
}

export interface PlaylistEntry {
  videoId: string
  title: string
  duration?: number
  channel: string | null
  thumbnail: string | null
}

export interface PlaylistResult {
  entries: PlaylistEntry[]
  capped: boolean
  title?: string
  mix: boolean
  error?: string
}

/** Flat playlist listing -> entries (at most `limit`; "capped" says there was more, a Mix is always cut short). */
export function parsePlaylist(stdout: string, mix: boolean, limit: number): PlaylistResult {
  try {
    const info = JSON.parse(stdout) as { title?: string; entries?: FlatEntry[] }
    const all = (info.entries ?? []).filter((e) => isVideoId(e.id) && e.title)
    const entries: PlaylistEntry[] = all.slice(0, limit).map((e) => ({
      videoId: e.id as string,
      title: e.title as string,
      duration: typeof e.duration === 'number' ? e.duration : undefined,
      channel: e.channel ?? e.uploader ?? null,
      thumbnail: firstThumb(e) ?? thumb(e.id as string)
    }))
    if (entries.length === 0) return { entries: [], capped: false, mix, error: 'No playable videos were found in this playlist.' }
    return { entries, capped: mix ? entries.length >= limit : all.length > limit, title: info.title, mix }
  } catch {
    return { entries: [], capped: false, mix, error: 'Could not read this playlist.' }
  }
}

/** Playlist rows as search results (what pasting a playlist link shows). */
export function playlistToResults(r: PlaylistResult, max = 50): OnlineSearchResult[] {
  return r.entries.slice(0, max).map((e) => ({
    provider: 'youtube',
    id: `youtube:${e.videoId}`,
    title: e.title,
    artist: e.channel ?? r.title ?? 'YouTube Playlist',
    album: r.title ?? null,
    duration: e.duration && e.duration > 0 ? e.duration : null,
    year: null,
    artworkUrl: e.thumbnail,
    url: watchUrl(e.videoId),
    previewUrl: null,
    videoId: e.videoId
  }))
}

export interface VideoMeta {
  title: string
  channel: string | null
  thumbnail: string | null
  duration: number | null
  /** yt-dlp's own music tags when the video has them (YouTube Music "Topic" uploads). */
  track: string | null
  artist: string | null
  album: string | null
  year: number | null
}

export function parseVideoMeta(stdout: string): VideoMeta | null {
  try {
    const d = JSON.parse(stdout) as {
      title?: string
      channel?: string
      uploader?: string
      thumbnail?: string
      duration?: number
      track?: string
      artist?: string
      artists?: string[]
      album?: string
      release_year?: number
    }
    if (!d.title) return null
    return {
      title: d.title,
      channel: d.channel ?? d.uploader ?? null,
      thumbnail: d.thumbnail ?? null,
      duration: typeof d.duration === 'number' && d.duration > 0 ? d.duration : null,
      track: d.track ?? null,
      artist: d.artist ?? (Array.isArray(d.artists) ? d.artists.join(', ') : null) ?? null,
      album: d.album ?? null,
      year: typeof d.release_year === 'number' ? d.release_year : null
    }
  } catch {
    return null
  }
}

interface YtFormat {
  url?: string
  ext?: string
  acodec?: string
  vcodec?: string
  abr?: number
  tbr?: number
  mimeType?: string
  height?: number
  protocol?: string
  http_headers?: Record<string, string>
}

export interface StreamSet {
  /** Playable addresses, best first. */
  urls: string[]
  /** Request headers each address wants (User-Agent ...), by address. */
  headers: Record<string, Record<string, string>>
}

const HEADER_ALLOW = new Set(['user-agent', 'accept', 'accept-language', 'referer', 'origin'])

function safeHeaders(h: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(h ?? {})) if (HEADER_ALLOW.has(k.toLowerCase()) && typeof v === 'string') out[k] = v
  return out
}

/**
 * Every playable audio address of a video (yt-dlp -j output), best first: MP4/AAC audio-only, then other audio-only,
 * then muxed video+audio; streaming playlists (m3u8 / mpd) are skipped.
 */
export function extractStreams(stdout: string): StreamSet {
  try {
    const data = JSON.parse(stdout) as { formats?: YtFormat[]; http_headers?: Record<string, string> }
    const formats = Array.isArray(data.formats) ? data.formats : []
    const seen = new Set<string>()
    const headers: Record<string, Record<string, string>> = {}
    const push = (f: YtFormat): void => {
      const u = f.url?.trim()
      if (!u || seen.has(u) || !/^https?:\/\//.test(u) || /\.m3u8/i.test(u) || /\.mpd/i.test(u)) return
      seen.add(u)
      headers[u] = safeHeaders(f.http_headers ?? data.http_headers)
    }
    const quality = (f: YtFormat): number => f.abr ?? f.tbr ?? 0
    const audioOnly = formats.filter((f) => f.vcodec === 'none' && f.acodec && f.acodec !== 'none' && f.url)
    const muxed = formats.filter((f) => f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && f.url)
    const isMp4Audio = (f: YtFormat): boolean => f.ext === 'm4a' || f.ext === 'mp4' || /audio\/mp4|audio\/mpeg/i.test(f.mimeType ?? '')
    const byQuality = (a: YtFormat, b: YtFormat): number => quality(b) - quality(a)
    ;[...audioOnly.filter(isMp4Audio).sort(byQuality), ...audioOnly.filter((f) => !isMp4Audio(f)).sort(byQuality)].forEach(push)
    muxed.sort(byQuality).forEach(push)
    return { urls: [...seen], headers }
  } catch {
    return { urls: [], headers: {} }
  }
}

/** One way to watch a video: a picture stream (with its own sound when audioUrl is empty) at one height. */
export interface VideoOption {
  height: number
  label: string
  videoUrl: string
  /** Separate audio stream to play along with videoUrl (empty when the picture stream already has sound). */
  audioUrl: string
  headers: Record<string, string>
}

/**
 * The qualities a video can be watched in, best first. YouTube serves sharp pictures (720p and up) without sound, so
 * each of those is paired with the best audio-only stream; muxed streams (picture + sound, usually 360p) are the fallback.
 */
export function extractVideoOptions(stdout: string): VideoOption[] {
  try {
    const data = JSON.parse(stdout) as { formats?: YtFormat[]; http_headers?: Record<string, string> }
    const formats = (Array.isArray(data.formats) ? data.formats : []).filter(
      (f) => f.url && /^https?:\/\//.test(f.url) && !/\.m3u8|\.mpd/i.test(f.url) && !(f.protocol ?? '').startsWith('m3u8')
    )
    const hasVideo = (f: YtFormat): boolean => !!f.vcodec && f.vcodec !== 'none' && (f.height ?? 0) > 0
    const hasAudio = (f: YtFormat): boolean => !!f.acodec && f.acodec !== 'none'
    const rate = (f: YtFormat): number => f.tbr ?? f.abr ?? 0
    const hdr = (f: YtFormat): Record<string, string> => safeHeaders(f.http_headers ?? data.http_headers)
    const isAvc = (f: YtFormat): boolean => /^avc1/i.test(f.vcodec ?? '')
    const isM4a = (f: YtFormat): boolean => f.ext === 'm4a' || /audio\/mp4/i.test(f.mimeType ?? '')
    const bestAudio = formats
      .filter((f) => !hasVideo(f) && hasAudio(f))
      .sort((a, b) => (isM4a(a) !== isM4a(b) ? (isM4a(a) ? -1 : 1) : rate(b) - rate(a)))[0]
    // h264 plays on every phone; a sharper codec is only chosen when nothing else has that height
    const better = (a: YtFormat, b: YtFormat | undefined): boolean => !b || (isAvc(a) !== isAvc(b) ? isAvc(a) : rate(a) > rate(b))
    const pick = (list: YtFormat[]): Map<number, YtFormat> => {
      const m = new Map<number, YtFormat>()
      for (const f of list) if (better(f, m.get(f.height as number))) m.set(f.height as number, f)
      return m
    }
    const out = new Map<number, VideoOption>()
    if (bestAudio) {
      for (const [h, f] of pick(formats.filter((x) => hasVideo(x) && !hasAudio(x)))) {
        out.set(h, { height: h, label: h + 'p', videoUrl: f.url as string, audioUrl: bestAudio.url as string, headers: hdr(f) })
      }
    }
    for (const [h, f] of pick(formats.filter((x) => hasVideo(x) && hasAudio(x)))) {
      if (!out.has(h)) out.set(h, { height: h, label: h + 'p', videoUrl: f.url as string, audioUrl: '', headers: hdr(f) })
    }
    return [...out.values()].sort((a, b) => b.height - a.height)
  } catch {
    return []
  }
}

/** How long resolved addresses stay usable: YouTube signs them with an expiry (about 6 hours). */
export function streamExpiry(urls: string[], now = Date.now()): number {
  const m = /[?&/]expire[=/](\d+)/.exec(urls[0] ?? '')
  if (!m) return now + 15 * 60_000
  const at = Number(m[1]) * 1000 - 10 * 60_000
  return at > now + 60_000 ? Math.min(at, now + 5.5 * 3600_000) : now + 60_000
}

// ------------------------------------------------------------------ tags for downloaded songs
/** Strip "| separators", bracketed tags and "(Official Video...)" noise from a YouTube title (same rules as the PC app). */
export function cleanTrackTitle(raw: string): string {
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
    /\bofficial\b/gi
  ]
  for (const re of strip) t = t.replace(re, ' ')
  t = t.replace(/\s{2,}/g, ' ').trim()
  t = t.replace(/^[\s\-–—]+|[\s\-–—]+$/g, '')
  return t.slice(0, 120)
}

export interface SongTags {
  title: string
  artist: string
  album: string
}

/**
 * Title / artist for a downloaded YouTube song. A "Topic" channel or YouTube's own music tags are exact; otherwise
 * "Artist - Title" is split, else the channel is the artist. Approximate by nature: the owner can edit the tags.
 */
export function songTagsFor(title: string, channel: string | null, meta?: Partial<VideoMeta> | null): SongTags {
  if (meta?.track && meta.artist) {
    return { title: meta.track, artist: meta.artist, album: meta.album ?? '' }
  }
  const cleaned = cleanTrackTitle(title) || title.trim() || 'Untitled'
  const chan = (channel ?? '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim()
  if (channel && /-\s*Topic$/i.test(channel)) return { title: cleaned, artist: chan || 'Unknown Artist', album: meta?.album ?? '' }
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(cleaned)
  if (m) return { title: m[2].trim(), artist: m[1].trim(), album: meta?.album ?? '' }
  return { title: cleaned, artist: chan || 'Unknown Artist', album: meta?.album ?? '' }
}
