/**
 * Backend for platforms without the Electron main process (the Android app, or a plain browser).
 *
 * The screens talk to `window.cytto.invoke(channel, ...)`. On desktop the Electron main process answers;
 * here this file answers instead, inside the web view. It implements what the Android app supports so far:
 * settings, the Internet Archive (search, listing, downloads to the phone), and a small song list made of the
 * files that were downloaded. Everything else answers with an empty result so every screen still opens.
 *
 * Phase status is tracked in ANDROID_PLAN.md.
 */
import { Directory, Filesystem } from '@capacitor/filesystem'
import { DEFAULT_SETTINGS } from '@shared/constants'
import {
  ARCHIVE_ITEM_CACHE_MS,
  ARCHIVE_TIMEOUT_MS,
  buildDownloadUrl,
  buildSearchUrl,
  isValidIdentifier,
  parseHits,
  parseItem
} from '@shared/archiveCore'
import { IPC } from '@shared/ipc'
import type {
  Album,
  Artist,
  ArchiveFile,
  ArchiveItem,
  ArchiveSearchResult,
  DownloadItem,
  Track,
  YtEngineStatus
} from '@shared/types'

type Handler = (...args: never[]) => unknown
type Listener = (...args: unknown[]) => void

const SETTINGS_KEY = 'oli.settings'
const SONGS_KEY = 'oli.songs'
const DOWNLOADS_KEY = 'oli.downloads'
const APP_VERSION = '1.1.0'

// ------------------------------------------------------------------ small helpers
function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // storage full or blocked: keep working in memory
  }
}
const uid = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const slug = (s: string): string => s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
/** File and folder names: same rules as the desktop app (no path characters, capped length). */
const safeName = (s: string): string =>
  s.replace(/[<>:"/\\|?*]/g, '_').replace(/\p{C}/gu, '_').trim().slice(0, 120) || 'download'

// ------------------------------------------------------------------ events
const listeners = new Map<string, Set<Listener>>()
function emit(channel: string, ...args: unknown[]): void {
  for (const fn of listeners.get(channel) ?? []) {
    try {
      fn(...args)
    } catch {
      // a broken listener must not stop the others
    }
  }
}

// ------------------------------------------------------------------ settings
function currentSettings(): Record<string, unknown> {
  return { ...DEFAULT_SETTINGS, ...readJson<Record<string, unknown>>(SETTINGS_KEY, {}) }
}
function setSettings(patch: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...readJson<Record<string, unknown>>(SETTINGS_KEY, {}), ...patch }
  writeJson(SETTINGS_KEY, merged)
  emit(IPC.onSettingsChanged, patch)
  return currentSettings()
}

// ------------------------------------------------------------------ songs (files downloaded on this phone)
let songs: Track[] = readJson<Track[]>(SONGS_KEY, [])

function saveSongs(): void {
  writeJson(SONGS_KEY, songs)
  emit(IPC.onLibraryChanged, libraryStats())
}

function makeTrack(file: ArchiveFile, item: ArchiveItem, uri: string, size: number): Track {
  const artist = file.artist ?? item.creator ?? 'Unknown Artist'
  const album = file.album ?? item.title ?? 'Unknown Album'
  const year = item.date ? Number.parseInt(item.date.slice(0, 4), 10) : NaN
  const now = Date.now()
  return {
    id: `song:${uri}`,
    title: file.title ?? file.name.replace(/\.[^.]+$/, '').replace(/_/g, ' '),
    artist,
    artistId: `artist:${slug(artist)}`,
    albumArtist: item.creator ?? artist,
    album,
    albumId: `album:${slug(item.creator ?? '')}:${slug(album)}`,
    genre: file.genre,
    composer: null,
    year: Number.isFinite(year) ? year : null,
    releaseDate: item.date,
    trackNo: Number.parseInt(file.track ?? '', 10) || null,
    discNo: null,
    isrc: null,
    rating: null,
    duration: file.durationSec ?? 0,
    bitrate: null,
    sampleRate: null,
    bitDepth: file.format.startsWith('24bit') ? 24 : null,
    channels: null,
    codec: null,
    format: file.label,
    fileSize: size,
    path: uri,
    folderId: null,
    libraryId: null,
    hash: null,
    replayGain: null,
    replayGainAlbum: null,
    lyrics: null,
    hasEmbeddedArtwork: false,
    addedAt: now,
    modifiedAt: now,
    lastPlayedAt: null,
    playCount: 0,
    favorite: false,
    missing: false,
    error: null
  }
}

function group<T>(items: T[], keyOf: (t: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const it of items) {
    const k = keyOf(it)
    if (!k) continue
    out.set(k, [...(out.get(k) ?? []), it])
  }
  return out
}

function albums(): Album[] {
  return [...group(songs, (t) => t.albumId).entries()].map(([id, list]) => ({
    id,
    title: list[0].album,
    artist: list[0].albumArtist || list[0].artist,
    year: list[0].year,
    genre: list[0].genre,
    trackId: list[0].id,
    trackCount: list.length,
    totalDuration: list.reduce((s, t) => s + t.duration, 0),
    favorite: false,
    hasEmbeddedArtwork: false,
    addedAt: Math.min(...list.map((t) => t.addedAt))
  }))
}

function artists(): Artist[] {
  return [...group(songs, (t) => t.artistId).entries()].map(([id, list]) => ({
    id,
    name: list[0].artist,
    sortName: list[0].artist.toLowerCase(),
    genre: list[0].genre,
    biography: null,
    favorite: false,
    trackCount: list.length,
    albumCount: new Set(list.map((t) => t.albumId)).size,
    addedAt: Math.min(...list.map((t) => t.addedAt))
  }))
}

function libraryStats(): Record<string, number> {
  return {
    folderCount: songs.length > 0 ? 1 : 0,
    trackCount: songs.length,
    albumCount: albums().length,
    artistCount: artists().length,
    playlistCount: 0,
    favoriteCount: 0,
    missingCount: 0,
    totalDuration: songs.reduce((s, t) => s + t.duration, 0),
    totalSize: songs.reduce((s, t) => s + (t.fileSize ?? 0), 0)
  }
}

const SORT_KEYS: Record<string, (t: Track) => string | number> = {
  title: (t) => t.title.toLowerCase(),
  artist: (t) => t.artist.toLowerCase(),
  album: (t) => t.album.toLowerCase(),
  year: (t) => t.year ?? 0,
  addedAt: (t) => t.addedAt,
  lastPlayed: (t) => t.lastPlayedAt ?? 0,
  playCount: (t) => t.playCount ?? 0,
  duration: (t) => t.duration,
  trackNo: (t) => t.trackNo ?? 0
}

function querySongs(q: Record<string, unknown> = {}): { tracks: Track[]; total: number } {
  let list = [...songs]
  const text = typeof q.search === 'string' ? q.search.trim().toLowerCase() : ''
  if (text) list = list.filter((t) => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(text))
  if (typeof q.albumId === 'string') list = list.filter((t) => t.albumId === q.albumId)
  if (typeof q.artistId === 'string') list = list.filter((t) => t.artistId === q.artistId)
  if (typeof q.format === 'string' && q.format) list = list.filter((t) => (t.format ?? '').toLowerCase().includes(String(q.format).toLowerCase()))
  const sort = typeof q.sort === 'string' ? q.sort : 'title'
  if (sort === 'random') list.sort(() => Math.random() - 0.5)
  else {
    const key = SORT_KEYS[sort] ?? SORT_KEYS.title
    const dir = q.direction === 'desc' ? -1 : 1
    list.sort((a, b) => (key(a) < key(b) ? -dir : key(a) > key(b) ? dir : 0))
  }
  const total = list.length
  const offset = Number(q.offset) || 0
  const limit = Number(q.limit) || 0
  if (offset || limit) list = list.slice(offset, limit ? offset + limit : undefined)
  return { tracks: list, total }
}

// ------------------------------------------------------------------ Internet Archive (fetch straight from the phone)
const itemCache = new Map<string, { at: number; item: ArchiveItem }>()

async function getJson(url: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ARCHIVE_TIMEOUT_MS)
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal })
    if (!res.ok) throw new Error(`archive.org answered HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function describe(err: unknown): string {
  const e = err as Error
  return e?.name === 'AbortError' ? 'archive.org took too long to answer' : e?.message || 'Could not reach archive.org'
}

async function archiveSearch(text: string, page = 1, losslessOnly = true): Promise<ArchiveSearchResult> {
  const url = buildSearchUrl(String(text ?? '').slice(0, 200), Number(page) || 1, losslessOnly !== false)
  if (!url) return { hits: [], total: 0, page: 1 }
  try {
    const { hits, total } = parseHits(await getJson(url))
    return { hits, total, page: Number(page) || 1 }
  } catch (err) {
    return { hits: [], total: 0, page: Number(page) || 1, error: describe(err) }
  }
}

async function archiveItem(identifier: string): Promise<ArchiveItem> {
  const empty = (error: string): ArchiveItem => ({
    identifier: String(identifier),
    title: '',
    creator: null,
    date: null,
    licenseUrl: null,
    files: [],
    images: [],
    error
  })
  if (!isValidIdentifier(identifier)) return empty('Invalid item')
  const cached = itemCache.get(identifier)
  if (cached && Date.now() - cached.at < ARCHIVE_ITEM_CACHE_MS) return cached.item
  try {
    const item = parseItem(identifier, await getJson(`https://archive.org/metadata/${encodeURIComponent(identifier)}`))
    itemCache.set(identifier, { at: Date.now(), item })
    return item
  } catch (err) {
    return empty(describe(err))
  }
}

// ------------------------------------------------------------------ downloads (saved into the app's storage on the phone)
interface Job {
  file: ArchiveFile
  item: ArchiveItem
  relPath: string
}

let downloads: DownloadItem[] = readJson<DownloadItem[]>(DOWNLOADS_KEY, []).map((d) =>
  // A download that was running when the app closed cannot continue: show it as failed so it can be retried.
  d.state === 'downloading' || d.state === 'queued' ? { ...d, state: 'failed', error: 'Interrupted', speed: 0 } : d
)
const jobs = new Map<string, Job>()
let pumping = false

function publishDownloads(): void {
  writeJson(DOWNLOADS_KEY, downloads.slice(0, 200))
  emit(IPC.onDownloadsChanged, [...downloads])
}

function patchDownload(id: string, patch: Partial<DownloadItem>): void {
  downloads = downloads.map((d) => (d.id === id ? { ...d, ...patch, updatedAt: Date.now() } : d))
  publishDownloads()
}

async function pumpDownloads(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    for (;;) {
      const next = [...downloads].reverse().find((d) => d.state === 'queued' && jobs.has(d.id))
      if (!next) break
      await downloadOne(next, jobs.get(next.id) as Job)
    }
  } finally {
    pumping = false
  }
}

async function downloadOne(row: DownloadItem, job: Job): Promise<void> {
  patchDownload(row.id, { state: 'downloading', error: null })
  const startedAt = Date.now()
  const handle = await Filesystem.addListener('progress', (ev) => {
    if (ev.url !== row.url) return
    const total = ev.contentLength > 0 ? ev.contentLength : job.file.size
    const elapsed = Math.max(1, (Date.now() - startedAt) / 1000)
    const speed = ev.bytes / elapsed
    patchDownload(row.id, {
      downloadedBytes: ev.bytes,
      totalBytes: total || null,
      progress: total ? Math.min(1, ev.bytes / total) : 0,
      speed: Math.round(speed),
      etaSeconds: total && speed > 0 ? Math.round((total - ev.bytes) / speed) : null
    })
  })
  try {
    const res = await Filesystem.downloadFile({
      url: row.url,
      path: job.relPath,
      directory: Directory.External,
      recursive: true,
      progress: true
    })
    const uri = (await Filesystem.getUri({ path: job.relPath, directory: Directory.External })).uri
    const stat = await Filesystem.stat({ path: job.relPath, directory: Directory.External })
    if (job.file.size > 0 && stat.size !== job.file.size) {
      throw new Error(`Incomplete download (${stat.size} of ${job.file.size} bytes)`)
    }
    songs = songs.filter((t) => t.path !== uri)
    songs.push(makeTrack(job.file, job.item, uri, stat.size))
    saveSongs()
    patchDownload(row.id, {
      state: 'completed',
      progress: 1,
      speed: 0,
      etaSeconds: null,
      downloadedBytes: stat.size,
      totalBytes: stat.size,
      destPath: res.path ?? uri
    })
  } catch (err) {
    patchDownload(row.id, { state: 'failed', speed: 0, error: (err as Error).message || 'Download failed' })
  } finally {
    void handle.remove()
    jobs.delete(row.id)
  }
}

async function archiveEnqueue(identifier: string, fileNames: string[]): Promise<{ found: number; enqueued: number }> {
  if (!isValidIdentifier(identifier) || !Array.isArray(fileNames)) return { found: 0, enqueued: 0 }
  const item = await archiveItem(identifier)
  const wanted = new Set(fileNames.filter((n) => typeof n === 'string').slice(0, 500))
  const chosen = item.files.filter((f) => wanted.has(f.name))
  let enqueued = 0
  for (const f of chosen) {
    const url = buildDownloadUrl(identifier, f.name)
    const base = f.name.split('/').pop() ?? f.name
    const dot = base.lastIndexOf('.')
    const ext = dot > 0 ? base.slice(dot, dot + 9) : ''
    const relPath = `Oli/${safeName(item.title || identifier)}/${safeName(dot > 0 ? base.slice(0, dot) : base)}${ext}`
    if (downloads.some((d) => d.url === url && (d.state === 'queued' || d.state === 'downloading'))) continue
    const id = uid()
    const now = Date.now()
    jobs.set(id, { file: f, item, relPath })
    downloads = [
      {
        id,
        title: f.title ?? base,
        url,
        destPath: relPath,
        state: 'queued',
        progress: 0,
        totalBytes: f.size || null,
        downloadedBytes: 0,
        speed: 0,
        etaSeconds: null,
        error: null,
        createdAt: now,
        updatedAt: now
      },
      ...downloads
    ]
    enqueued++
  }
  publishDownloads()
  void pumpDownloads()
  return { found: chosen.length, enqueued }
}

// ------------------------------------------------------------------ channel table
const engineStatus: YtEngineStatus = {
  state: 'ok',
  version: null,
  latest: null,
  source: null,
  path: null,
  message: null,
  auto: false
}
const noop = (): null => null
const empty = (): unknown[] => []

const handlers: Record<string, Handler> = {
  // app and window
  [IPC.getAppInfo]: () => ({ name: 'Oli', version: APP_VERSION, electron: 'n/a (Android)', chrome: navigator.userAgent, node: 'n/a' }),
  [IPC.windowControl]: noop,
  [IPC.getWindowState]: () => ({ maximized: true, fullscreen: false }),
  [IPC.checkForUpdates]: () => ({
    checked: true,
    currentVersion: APP_VERSION,
    latestVersion: null,
    updateAvailable: false,
    updateUrl: null,
    error: null,
    checkedAt: Date.now()
  }),
  [IPC.openReleasePage]: (url?: string) => {
    window.open(url ?? 'https://github.com/CyttoRak-J/Oli/releases', '_blank')
    return null
  },
  // settings
  [IPC.getSettings]: () => currentSettings(),
  [IPC.setSettings]: ((patch: Record<string, unknown>) => setSettings(patch ?? {})) as Handler,
  // library (the songs are the files downloaded on this phone)
  [IPC.getLibrary]: empty,
  [IPC.getStats]: () => libraryStats(),
  [IPC.getSongs]: ((q?: Record<string, unknown>) => querySongs(q)) as Handler,
  [IPC.getSongById]: ((id: string) => songs.find((t) => t.id === id) ?? null) as Handler,
  [IPC.getAlbums]: () => albums(),
  [IPC.getAlbumById]: ((id: string) => albums().find((a) => a.id === id) ?? null) as Handler,
  [IPC.getAlbumSongs]: ((id: string) => songs.filter((t) => t.albumId === id).sort((a, b) => (a.trackNo ?? 0) - (b.trackNo ?? 0))) as Handler,
  [IPC.getArtists]: () => artists(),
  [IPC.getArtistById]: ((id: string) => artists().find((a) => a.id === id) ?? null) as Handler,
  [IPC.getArtistAlbums]: ((id: string) => albums().filter((a) => songs.some((t) => t.albumId === a.id && t.artistId === id))) as Handler,
  [IPC.getArtistSongs]: ((id: string) => songs.filter((t) => t.artistId === id)) as Handler,
  [IPC.getGenres]: empty,
  [IPC.getGenreSongs]: empty,
  [IPC.getComposers]: empty,
  [IPC.getComposerSongs]: empty,
  [IPC.getSimilarTracks]: empty,
  [IPC.getScanState]: noop,
  [IPC.addLibraryFolder]: noop,
  [IPC.removeLibraryFolder]: noop,
  [IPC.rescanLibrary]: noop,
  [IPC.cancelScan]: noop,
  [IPC.metaNeedsAttention]: empty,
  [IPC.getEmbeddedArtwork]: noop,
  [IPC.revealInExplorer]: () => false,
  [IPC.getMediaBase]: () => '',
  [IPC.probeDuration]: noop,
  [IPC.transcodeLocalFile]: noop,
  [IPC.getLyrics]: noop,
  // search (library only; no online providers on Android yet)
  [IPC.search]: ((q: string) => ({
    local: querySongs({ search: String(q ?? '') }).tracks.slice(0, 60),
    online: [],
    suggestions: [],
    onlineDone: true
  })) as Handler,
  [IPC.getSearchHistory]: empty,
  [IPC.clearSearchHistory]: noop,
  [IPC.removeSearchHistory]: noop,
  [IPC.pinSearch]: noop,
  [IPC.unpinSearch]: noop,
  [IPC.isProviderConfigured]: () => ({ spotifyConfigured: false, youtubeConfigured: false }),
  // YouTube: not available on Android yet
  [IPC.ytEngineInfo]: () => engineStatus,
  [IPC.ytEngineCheck]: () => engineStatus,
  [IPC.ytEngineUpdate]: () => engineStatus,
  [IPC.resolveYouTubeStream]: empty,
  [IPC.resolveYouTubeStreamBatch]: empty,
  [IPC.resolveYouTubeUrl]: empty,
  [IPC.resolvePlaylistEntries]: () => ({ entries: [], error: 'YouTube is not available in the Android app yet.' }),
  // playlists / favorites / queue / history (not persisted on Android yet)
  [IPC.getPlaylists]: empty,
  [IPC.getPlaylist]: noop,
  [IPC.getPlaylistEntries]: empty,
  [IPC.createPlaylist]: noop,
  [IPC.getFavorites]: empty,
  [IPC.toggleFavorite]: () => false,
  [IPC.getQueue]: empty,
  [IPC.saveQueue]: noop,
  [IPC.clearQueue]: noop,
  [IPC.getHistory]: empty,
  [IPC.clearHistory]: noop,
  [IPC.getPlaybackState]: () => ({
    songId: null,
    status: 'idle',
    currentTime: 0,
    duration: 0,
    volume: 0.8,
    muted: false,
    shuffle: false,
    repeat: 'off',
    positionMeta: { queueIndex: -1, queueLength: 0 },
    timestamp: Date.now()
  }),
  // downloads
  [IPC.getDownloads]: () => [...downloads],
  [IPC.cancelDownload]: ((id: string) => {
    jobs.delete(id)
    patchDownload(id, { state: 'canceled', speed: 0 })
    return null
  }) as Handler,
  [IPC.removeDownload]: ((id: string) => {
    jobs.delete(id)
    downloads = downloads.filter((d) => d.id !== id)
    publishDownloads()
    return null
  }) as Handler,
  [IPC.clearCompleted]: () => {
    downloads = downloads.filter((d) => !['completed', 'failed', 'canceled'].includes(d.state))
    publishDownloads()
    return null
  },
  [IPC.clearPending]: () => 0,
  [IPC.pauseAllDownload]: () => 0,
  [IPC.resumeAllDownload]: () => 0,
  [IPC.pauseDownload]: noop,
  [IPC.resumeDownload]: noop,
  [IPC.retryDownload]: noop,
  [IPC.revealDownload]: () => false,
  [IPC.openDownloadsFolder]: noop,
  [IPC.videoPickFolder]: noop,
  // Internet Archive
  [IPC.archiveSearch]: ((text: string, page?: number, lossless?: boolean) => archiveSearch(text, page, lossless)) as Handler,
  [IPC.archiveItem]: ((identifier: string) => archiveItem(identifier)) as Handler,
  [IPC.archiveEnqueue]: ((identifier: string, names: string[]) => archiveEnqueue(identifier, names)) as Handler,
  // backup
  [IPC.listBackups]: empty
}

const warned = new Set<string>()

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers[channel]
  if (!handler) {
    if (!warned.has(channel)) {
      warned.add(channel)
      console.warn(`[android] channel not supported yet: ${channel}`)
    }
    return null
  }
  return (handler as (...a: unknown[]) => unknown)(...args)
}

/** Install `window.cytto` for platforms that have no Electron preload. */
export function installWebBackend(platform: 'android' | 'web'): void {
  window.cytto = {
    platform,
    versions: { electron: 'n/a', chrome: navigator.userAgent, node: 'n/a' },
    invoke,
    send: (channel, ...args) => void invoke(channel, ...args),
    on: (channel, listener) => {
      const set = listeners.get(channel) ?? new Set<Listener>()
      set.add(listener)
      listeners.set(channel, set)
      return () => set.delete(listener)
    },
    once: (channel, listener) => {
      const off = window.cytto.on(channel, (...a) => {
        off()
        listener(...a)
      })
      return off
    }
  }
}
