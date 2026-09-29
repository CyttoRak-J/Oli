/**
 * YouTube for the phone app: the questions the screens ask (search, a pasted link, a playlist, "play this video",
 * engine status) answered through the native OliYouTube plugin (yt-dlp) and the reading rules in youtubeCore.ts.
 * Results are remembered for a while and identical questions share one yt-dlp run, because starting yt-dlp on a phone
 * takes seconds.
 */
import type { OnlineSearchResult, YtEngineStatus } from '@shared/types'
import {
  MIX_LIMIT,
  PLAYLIST_LIMIT,
  extractStreams,
  isVideoId,
  isYouTubeUrl,
  parsePlaylist,
  parseSearch,
  parseVideoMeta,
  playlistTarget,
  playlistToResults,
  streamExpiry,
  videoIdFromUrl,
  type PlaylistResult,
  type VideoMeta
} from './youtubeCore'

interface ListenerHandle {
  remove(): Promise<void> | void
}

/** The native plugin as JavaScript sees it (the download half is in downloadQueue.ts). */
export interface OliYouTubePlugin {
  status(): Promise<{ ready: boolean; version?: string; versionName?: string; error?: string }>
  updateEngine(o: { channel?: string }): Promise<{ status: string; version: string }>
  search(o: { query: string; count?: number }): Promise<{ json: string; client?: string }>
  playlist(o: { url: string; limit?: number }): Promise<{ json: string; client?: string }>
  info(o: { videoId: string; streams?: boolean }): Promise<{ json: string; client?: string }>
  enqueue(o: YouTubeDownloadSpec & { id: string }): Promise<void>
  pause(o: { id: string }): Promise<void>
  resume(o: { id: string }): Promise<void>
  cancel(o: { id: string }): Promise<void>
  getActive(): Promise<{ ids: string[] }>
  addListener(event: string, cb: (data: never) => void): Promise<ListenerHandle> | ListenerHandle
}

export interface YouTubeDownloadSpec {
  videoId: string
  mode: 'song' | 'video'
  audio: string
  height: number
  /** Path below the app folder, without the file extension (yt-dlp adds it). */
  relBase: string
  title: string
  artist: string
  album: string
}

export interface YouTubeServiceOptions {
  plugin: OliYouTubePlugin
  /** Newest yt-dlp release number ("2026.08.19") or null when GitHub cannot be reached. */
  latestVersion: () => Promise<string | null>
  /** Tell the player which request headers an address needs. */
  setStreamHeaders: (url: string, headers: Record<string, string>) => void
  emitStatus: (s: YtEngineStatus) => void
  autoUpdate: () => boolean
  now?: () => number
}

const SEARCH_TTL = 3600_000
const PLAYLIST_TTL = 10 * 60_000

interface Cached<T> {
  at: number
  value: T
}

export class YouTubeService {
  private status: YtEngineStatus = { state: 'checking', version: null, latest: null, source: 'bundled', path: null, message: null, auto: true }
  private searches = new Map<string, Cached<OnlineSearchResult[]>>()
  private playlists = new Map<string, Cached<PlaylistResult>>()
  private streams = new Map<string, { urls: string[]; expires: number }>()
  private metas = new Map<string, VideoMeta | null>()
  private channels = new Map<string, string>()
  private inflight = new Map<string, Promise<unknown>>()
  private prefetchQueue: string[] = []
  private prefetching = false
  private readonly now: () => number

  constructor(private opts: YouTubeServiceOptions) {
    this.now = opts.now ?? Date.now
    this.status.auto = opts.autoUpdate()
  }

  /** One yt-dlp run for identical simultaneous questions. */
  private share<T>(key: string, run: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key)
    if (running) return running as Promise<T>
    const p = run().finally(() => this.inflight.delete(key))
    this.inflight.set(key, p)
    return p
  }

  // ------------------------------------------------------------------ engine
  getStatus(): YtEngineStatus {
    return { ...this.status, auto: this.opts.autoUpdate() }
  }

  private setStatus(patch: Partial<YtEngineStatus>): YtEngineStatus {
    this.status = { ...this.status, ...patch, auto: this.opts.autoUpdate() }
    this.opts.emitStatus(this.getStatus())
    return this.getStatus()
  }

  /** Starts the engine and reads its version (the first start unpacks Python, so this takes a few seconds). */
  async start(): Promise<YtEngineStatus> {
    this.setStatus({ state: 'checking', message: null })
    try {
      const s = await this.opts.plugin.status()
      if (!s.ready) return this.setStatus({ state: 'broken', version: null, message: s.error || 'The YouTube engine could not start.' })
      return this.setStatus({ state: 'ok', version: s.versionName || s.version || null, message: null })
    } catch (err) {
      return this.setStatus({ state: 'failed', message: String((err as Error)?.message ?? err) })
    }
  }

  /** Re-reads the installed version and asks GitHub for the newest one (installs it when "update automatically" is on). */
  async check(): Promise<YtEngineStatus> {
    await this.start()
    if (this.status.state !== 'ok') return this.getStatus()
    const latest = await this.opts.latestVersion().catch(() => null)
    const newer = latest != null && this.status.version != null && latest > this.status.version
    const st = this.setStatus({ latest, state: newer ? 'update-available' : 'ok' })
    if (newer && this.opts.autoUpdate()) return this.install()
    return st
  }

  /** Installs the newest yt-dlp (also when the version looks current: a damaged copy is replaced). */
  async install(): Promise<YtEngineStatus> {
    this.setStatus({ state: 'installing', message: null })
    try {
      const r = await this.opts.plugin.updateEngine({ channel: 'stable' })
      this.streams.clear() // addresses the old engine resolved may be refused by the new rules
      const version = r.version || this.status.version
      const message = r.status === 'DONE' ? `YouTube engine updated to ${version}` : 'The YouTube engine is already up to date'
      return this.setStatus({ state: 'ok', version, latest: version, message })
    } catch (err) {
      return this.setStatus({ state: 'failed', message: `Could not update the YouTube engine: ${String((err as Error)?.message ?? err)}` })
    }
  }

  // ------------------------------------------------------------------ search and links
  async search(query: string): Promise<OnlineSearchResult[]> {
    const q = query.trim()
    if (!q) return []
    const key = q.toLowerCase()
    const hit = this.searches.get(key)
    if (hit && this.now() - hit.at < SEARCH_TTL) return hit.value
    return this.share(`s:${key}`, async () => {
      try {
        const rows = parseSearch((await this.opts.plugin.search({ query: q, count: 20 })).json)
        for (const r of rows) if (r.videoId) this.channels.set(r.videoId, r.artist)
        if (rows.length > 0) this.searches.set(key, { at: this.now(), value: rows })
        return rows
      } catch {
        return []
      }
    })
  }

  /** The channel a video was listed under (from a search or playlist we already read), if known. */
  channelOf(videoId: string): string | null {
    return this.channels.get(videoId) ?? this.metas.get(videoId)?.channel ?? null
  }

  /** Metadata of one video (title, channel, thumbnail, YouTube Music tags when it has them). */
  async meta(videoId: string): Promise<VideoMeta | null> {
    if (!isVideoId(videoId)) return null
    if (this.metas.has(videoId)) return this.metas.get(videoId) ?? null
    return this.share(`m:${videoId}`, async () => {
      try {
        const m = parseVideoMeta((await this.opts.plugin.info({ videoId })).json)
        this.metas.set(videoId, m)
        return m
      } catch {
        return null
      }
    })
  }

  /** A pasted link: a playlist / Mix becomes its videos, a single video becomes one row. */
  async resolveUrl(url: string): Promise<OnlineSearchResult[]> {
    if (!isYouTubeUrl(url)) return []
    try {
      const u = new URL(url)
      const host = u.hostname.replace(/^(www\.|m\.|music\.)/i, '')
      if (host === 'youtube.com' && u.searchParams.get('list')) {
        const id = videoIdFromUrl(url)
        const asPlaylist = u.pathname === '/playlist' || u.searchParams.get('start_radio') != null || /^RD/.test(u.searchParams.get('list') ?? '') || !id
        if (asPlaylist) return playlistToResults(await this.playlistEntries(url))
      }
      const videoId = videoIdFromUrl(url)
      if (videoId) {
        const m = await this.meta(videoId)
        if (m) {
          return [
            {
              provider: 'youtube',
              id: `youtube:${videoId}`,
              title: m.title,
              artist: m.artist ?? m.channel ?? 'YouTube',
              album: m.album,
              duration: m.duration,
              year: m.year,
              artworkUrl: m.thumbnail,
              url: `https://www.youtube.com/watch?v=${videoId}`,
              previewUrl: null,
              videoId
            }
          ]
        }
      }
    } catch {
      // fall through
    }
    return []
  }

  /** Every video of a playlist / Mix (a Mix only opens through one of its videos). */
  async playlistEntries(url: string): Promise<PlaylistResult> {
    const target = playlistTarget(url)
    if (target?.isMix && !target.videoId) {
      return {
        entries: [],
        capped: false,
        mix: true,
        error: 'A YouTube Mix can only be opened from one of its videos. Paste the video link that contains "&list=RD…" (the address bar while the Mix plays).'
      }
    }
    const listUrl = target?.url ?? url
    if (!isYouTubeUrl(listUrl)) return { entries: [], capped: false, mix: false, error: 'This is not a YouTube link.' }
    const mix = target?.isMix ?? false
    const limit = mix ? MIX_LIMIT : PLAYLIST_LIMIT
    const hit = this.playlists.get(listUrl)
    if (hit && this.now() - hit.at < PLAYLIST_TTL) return hit.value
    return this.share(`p:${listUrl}`, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = parsePlaylist((await this.opts.plugin.playlist({ url: listUrl, limit })).json, mix, limit)
          if (r.entries.length > 0) {
            for (const e of r.entries) if (e.channel) this.channels.set(e.videoId, e.channel)
            this.playlists.set(listUrl, { at: this.now(), value: r })
            return r
          }
          if (r.error && attempt === 1) return r
        } catch {
          // try once more
        }
      }
      return { entries: [], capped: false, mix, error: 'Could not read this playlist. It may be private or unavailable.' }
    })
  }

  // ------------------------------------------------------------------ playing
  private cachedStreams(videoId: string): string[] | null {
    const s = this.streams.get(videoId)
    return s && s.expires > this.now() + 30_000 ? s.urls : null
  }

  /** Playable addresses for a video, best first (remembered until YouTube's expiry; `fresh` skips the memory). */
  async resolveStream(videoId: string, fresh = false): Promise<string[]> {
    if (!isVideoId(videoId)) return []
    if (!fresh) {
      const c = this.cachedStreams(videoId)
      if (c) return c
    }
    return this.share(`u:${videoId}`, async () => {
      try {
        const set = extractStreams((await this.opts.plugin.info({ videoId, streams: true })).json)
        if (set.urls.length === 0) return []
        for (const u of set.urls) this.opts.setStreamHeaders(u, set.headers[u] ?? {})
        this.streams.set(videoId, { urls: set.urls, expires: streamExpiry(set.urls, this.now()) })
        return set.urls
      } catch {
        return []
      }
    })
  }

  async resolveStreamBatch(videoIds: string[]): Promise<Array<{ videoId: string; urls: string[] }>> {
    const out: Array<{ videoId: string; urls: string[] }> = []
    for (const id of videoIds.slice(0, 12)) out.push({ videoId: id, urls: await this.resolveStream(id) })
    return out
  }

  /** Warm the cache for the songs that play next (one at a time, so a foreground request is not slowed). */
  prefetch(videoIds: string[], priority = false): void {
    const fresh = videoIds.filter((id) => isVideoId(id) && !this.cachedStreams(id) && !this.prefetchQueue.includes(id))
    if (priority) this.prefetchQueue.unshift(...fresh)
    else this.prefetchQueue.push(...fresh)
    if (this.prefetching) return
    this.prefetching = true
    void (async () => {
      try {
        while (this.prefetchQueue.length > 0) {
          const id = this.prefetchQueue.shift() as string
          await this.resolveStream(id)
        }
      } finally {
        this.prefetching = false
      }
    })()
  }
}

interface CapacitorGlobal {
  getPlatform?: () => string
  registerPlugin?: <T>(name: string) => T
  PluginHeaders?: Array<{ name: string }>
}
let proxy: OliYouTubePlugin | null = null

/** The native YouTube plugin, or null when this is not the Android app (or the APK was built without it). */
export function getYouTubePlugin(): OliYouTubePlugin | null {
  if (proxy) return proxy
  if (typeof window === 'undefined') return null
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor
  if (!cap || cap.getPlatform?.() !== 'android' || !cap.registerPlugin) return null
  if (Array.isArray(cap.PluginHeaders) && !cap.PluginHeaders.some((h) => h.name === 'OliYouTube')) return null
  proxy = cap.registerPlugin<OliYouTubePlugin>('OliYouTube')
  return proxy
}
