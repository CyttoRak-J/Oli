/**
 * Backend for platforms without the Electron main process (the Android app, or a plain browser).
 *
 * The screens talk to `window.cytto.invoke(channel, ...)`. On desktop the Electron main process answers; here this
 * file answers instead, inside the web view. Everything that is "database side" (settings, library screens, playlists,
 * favorites, queue, history, search, lyrics) comes from the SAME services the desktop app uses (androidCore.ts).
 * This file adds the phone-specific parts: Internet Archive search and downloads to the phone, and answers for the
 * features that are not built yet (YouTube, scanning the phone's music, ...), so every screen still opens.
 *
 * Status and next steps: ANDROID_PLAN.md.
 */
import { Directory, Filesystem } from '@capacitor/filesystem'
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
  ArchiveFile,
  ArchiveItem,
  ArchiveSearchResult,
  DownloadItem,
  Track,
  YtEngineStatus
} from '@shared/types'
import { deviceFileUrl } from '../lib/platform'
import { initAndroidCore, trackIds, type AndroidCore } from './androidCore'
import { getMediaPlugin, PHONE_LIBRARY_ID, PhoneLibrary } from './phoneLibrary'

type Handler = (...args: never[]) => unknown
type Listener = (...args: unknown[]) => void

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
/** File and folder names: same rules as the desktop app (no path characters, capped length). */
const safeName = (s: string): string =>
  s.replace(/[<>:"/\\|?*]/g, '_').replace(/\p{C}/gu, '_').trim().slice(0, 120) || 'download'

// ------------------------------------------------------------------ events (to the screens)
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

let core: AndroidCore
/** The phone's own music (null in a plain browser, where there is no native plugin). */
let phoneLib: PhoneLibrary | null = null

// ------------------------------------------------------------------ songs made from downloaded files
function makeTrack(file: ArchiveFile, item: ArchiveItem, uri: string, size: number): Track {
  const artist = file.artist ?? item.creator ?? 'Unknown Artist'
  const album = file.album ?? item.title ?? 'Unknown Album'
  const albumArtist = item.creator ?? ''
  const year = item.date ? Number.parseInt(item.date.slice(0, 4), 10) : NaN
  const now = Date.now()
  return {
    id: trackIds.songIdForPath(uri),
    title: file.title ?? file.name.replace(/\.[^.]+$/, '').replace(/_/g, ' '),
    artist,
    artistId: trackIds.artistIdFor(artist),
    albumArtist: albumArtist || artist,
    album,
    albumId: trackIds.albumIdFor(albumArtist, album),
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
    core.upsertTrack(makeTrack(job.file, job.item, uri, stat.size))
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

// ------------------------------------------------------------------ phone-specific channels and "not built yet" answers
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

/** Answered here (not by the shared services). Anything in the core handlers takes precedence over these. */
const phoneHandlers: Record<string, Handler> = {
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
  [IPC.openReleasePage]: ((url?: string) => {
    window.open(url ?? 'https://github.com/CyttoRak-J/Oli/releases', '_blank')
    return null
  }) as Handler,
  // the phone's own music (MediaStore through the native OliMedia plugin, see phoneLibrary.ts)
  [IPC.getScanState]: () => phoneLib?.getState() ?? null,
  [IPC.addLibraryFolder]: (async () => {
    if (!phoneLib || !(await phoneLib.addAndScan())) return null
    return core.handlers[IPC.getLibrary]()
  }) as Handler,
  [IPC.removeLibraryFolder]: ((id: string) => {
    if (id === PHONE_LIBRARY_ID) phoneLib?.remove()
    return null
  }) as Handler,
  [IPC.rescanLibrary]: () => {
    void phoneLib?.scan()
    return null
  },
  [IPC.cancelScan]: () => {
    phoneLib?.cancel()
    return null
  },
  [IPC.metaNeedsAttention]: empty,
  [IPC.getEmbeddedArtwork]: ((songId: string) =>
    phoneLib ? phoneLib.artworkFor(songId, (p) => deviceFileUrl(`file://${p}`)) : null) as Handler,
  [IPC.revealInExplorer]: () => false,
  [IPC.getMediaBase]: () => '',
  [IPC.probeDuration]: noop,
  [IPC.transcodeLocalFile]: noop,
  // YouTube: not available on Android yet
  [IPC.ytEngineInfo]: () => engineStatus,
  [IPC.ytEngineCheck]: () => engineStatus,
  [IPC.ytEngineUpdate]: () => engineStatus,
  [IPC.resolveYouTubeStream]: empty,
  [IPC.resolveYouTubeStreamBatch]: empty,
  [IPC.resolveYouTubeUrl]: empty,
  [IPC.resolvePlaylistEntries]: () => ({ entries: [], error: 'YouTube is not available in the Android app yet.' }),
  // backup
  [IPC.listBackups]: empty,
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
  [IPC.archiveEnqueue]: ((identifier: string, names: string[]) => archiveEnqueue(identifier, names)) as Handler
}

const warned = new Set<string>()

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = core.handlers[channel] ?? phoneHandlers[channel]
  if (!handler) {
    if (!warned.has(channel)) {
      warned.add(channel)
      console.warn(`[android] channel not supported yet: ${channel}`)
    }
    return null
  }
  return (handler as (...a: unknown[]) => unknown)(...args)
}

/** Open the database and install `window.cytto` for platforms that have no Electron preload. */
export async function installWebBackend(platform: 'android' | 'web'): Promise<void> {
  core = await initAndroidCore()
  core.onChange((channel, payload) => emit(channel, payload))
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
  void startPhoneLibrary()
}

/** Connects the phone's music: scan on launch when allowed, ask once on the very first start, follow changes. */
async function startPhoneLibrary(): Promise<void> {
  const plugin = getMediaPlugin()
  if (!plugin) return
  phoneLib = new PhoneLibrary({ plugin, store: core.phone, emitProgress: (p) => emit(IPC.onScanProgress, p) })
  try {
    await plugin.addListener('mediaChanged', () => phoneLib?.onMediaChanged())
  } catch {
    // no change notifications: rescans happen on launch and on request
  }
  const settings = (await core.handlers[IPC.getSettings]()) as { scanOnLaunch?: boolean }
  const hasLocation = (core.handlers[IPC.getLibrary]() as Array<{ id: string }>).some((f) => f.id === PHONE_LIBRARY_ID)
  const granted = (await plugin.getPermission().catch(() => ({ granted: false }))).granted
  if (hasLocation && granted) {
    if (settings.scanOnLaunch !== false) void phoneLib.scan()
    return
  }
  // First start: ask once (Settings > Library has the button for later).
  if (!hasLocation && localStorage.getItem('oli.phoneMusicAsked') !== '1') {
    localStorage.setItem('oli.phoneMusicAsked', '1')
    await phoneLib.addAndScan()
  }
}
