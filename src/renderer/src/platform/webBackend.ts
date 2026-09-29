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
import {
  ARCHIVE_ITEM_CACHE_MS,
  ARCHIVE_TIMEOUT_MS,
  buildDownloadUrl,
  buildSearchUrl,
  isValidIdentifier,
  parseHits,
  parseItem,
  pickCover
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
import { Directory, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { deviceFileUrl } from '../lib/platform'
import { initAndroidCore, trackIds, type AndroidCore } from './androidCore'
import { getMediaPlugin, PHONE_LIBRARY_ID, PhoneLibrary } from './phoneLibrary'
import { PhoneBackup, base64ToBytes, bytesToBase64, pickFileBytes, type BackupStorage } from './phoneBackup'
import { DownloadQueue, getDownloadPlugin, type CompletedFile, type DownloadJob, type DownloadStore } from './downloadQueue'

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

// ------------------------------------------------------------------ downloads (native queue, see downloadQueue.ts)
const JOBS_KEY = 'oli.downloadJobs'
let queue: DownloadQueue | null = null

const downloadStore: DownloadStore = {
  loadItems: () => readJson<DownloadItem[]>(DOWNLOADS_KEY, []),
  saveItems: (items) => writeJson(DOWNLOADS_KEY, items),
  loadJobs: () => readJson<Record<string, DownloadJob>>(JOBS_KEY, {}),
  saveJobs: (jobs) => writeJson(JOBS_KEY, jobs)
}

interface ArchiveJobMeta {
  file: ArchiveFile
  /** The item without its file lists (they are big and not needed to make the song). */
  item: ArchiveItem
}

/** A finished file becomes a song; its real format is read from the file. */
async function downloadCompleted(_d: DownloadItem, job: DownloadJob, file: CompletedFile): Promise<void> {
  const meta = job.meta as ArchiveJobMeta | undefined
  if (!meta) return
  const track = makeTrack(meta.file, meta.item, file.path, file.size)
  core.upsertTrack(track)
  await phoneLib?.describeFile(track.id, file.path)
}

async function startDownloads(): Promise<void> {
  const plugin = getDownloadPlugin()
  if (!plugin) return
  queue = new DownloadQueue({
    plugin,
    store: downloadStore,
    publish: (items) => emit(IPC.onDownloadsChanged, items),
    onCompleted: downloadCompleted
  })
  await queue.start()
}

async function archiveEnqueue(identifier: string, fileNames: string[]): Promise<{ found: number; enqueued: number }> {
  if (!isValidIdentifier(identifier) || !Array.isArray(fileNames)) return { found: 0, enqueued: 0 }
  const item = await archiveItem(identifier)
  const wanted = new Set(fileNames.filter((n) => typeof n === 'string').slice(0, 500))
  const chosen = item.files.filter((f) => wanted.has(f.name))
  if (!queue) return { found: chosen.length, enqueued: 0 }
  const lite: ArchiveItem = { ...item, files: [], images: [] }
  const year = item.date ? Number.parseInt(item.date.slice(0, 4), 10) : NaN
  const entries = chosen.map((f) => {
    const base = f.name.split('/').pop() ?? f.name
    const dot = base.lastIndexOf('.')
    const ext = dot > 0 ? base.slice(dot, dot + 9) : ''
    const cover = pickCover(item.images, f.name)
    const meta: ArchiveJobMeta = { file: f, item: lite }
    return {
      title: f.title ?? base,
      job: {
        url: buildDownloadUrl(identifier, f.name),
        relPath: `Oli/${safeName(item.title || identifier)}/${safeName(dot > 0 ? base.slice(0, dot) : base)}${ext}`,
        size: f.size,
        md5: f.md5 ?? '',
        coverUrl: cover ? buildDownloadUrl(identifier, cover.name) : undefined,
        tags: {
          title: f.title ?? undefined,
          artist: f.artist ?? item.creator ?? undefined,
          albumArtist: item.creator ?? undefined,
          album: f.album ?? item.title ?? undefined,
          genre: f.genre ?? undefined,
          trackNo: Number.parseInt(f.track ?? '', 10) || undefined,
          year: Number.isFinite(year) ? year : undefined
        },
        meta
      } satisfies DownloadJob
    }
  })
  return { found: chosen.length, enqueued: queue.add(entries) }
}

// ------------------------------------------------------------------ backup and restore (see phoneBackup.ts)
const BACKUP_DIR = 'Oli/backups'
const backupStorage: BackupStorage = {
  async list() {
    try {
      const r = await Filesystem.readdir({ path: BACKUP_DIR, directory: Directory.External })
      return r.files.map((f) => ({ name: f.name, createdAt: Number(f.mtime ?? f.ctime ?? 0), size: Number(f.size ?? 0) }))
    } catch {
      return []
    }
  },
  async write(name, bytes) {
    await Filesystem.writeFile({ path: `${BACKUP_DIR}/${name}`, data: bytesToBase64(bytes), directory: Directory.External, recursive: true })
  },
  async read(name) {
    const r = await Filesystem.readFile({ path: `${BACKUP_DIR}/${name}`, directory: Directory.External })
    return base64ToBytes(String(r.data))
  },
  async remove(name) {
    await Filesystem.deleteFile({ path: `${BACKUP_DIR}/${name}`, directory: Directory.External })
  }
}
let phoneBackup: PhoneBackup | null = null

/** Restore: the newest automatic backup if the owner agrees, otherwise a file they pick. */
async function restoreInteractive(): Promise<boolean> {
  if (!phoneBackup) return false
  const list = await phoneBackup.list()
  if (list.length > 0 && window.confirm(`Restore the automatic backup from ${new Date(list[0].createdAt).toLocaleString()}?

The current library is replaced. Cancel = choose a backup file instead.`)) {
    return phoneBackup.restoreNamed(list[0].name)
  }
  const bytes = await pickFileBytes()
  return bytes ? phoneBackup.restoreBytes(bytes) : false
}

async function exportLibraryFile(): Promise<boolean> {
  if (!phoneBackup) return false
  try {
    const name = `Oli-library-backup-${new Date().toISOString().slice(0, 10)}.sqlite`
    const w = await Filesystem.writeFile({ path: name, data: bytesToBase64(phoneBackup.snapshot()), directory: Directory.Cache })
    await Share.share({ title: 'Oli library backup', url: w.uri, dialogTitle: 'Save or send your Oli library' })
    return true
  } catch {
    return false
  }
}

/** A backup every day the app is used (the newest 8 are kept), like the PC. */
async function startBackups(): Promise<void> {
  phoneBackup = new PhoneBackup(core.db, backupStorage, () => core.afterRestore())
  setTimeout(() => {
    void (async () => {
      try {
        const list = await phoneBackup!.list()
        if (list.length === 0 || Date.now() - list[0].createdAt > 24 * 3600 * 1000) await phoneBackup!.create()
      } catch {
        // a failed automatic backup is not worth interrupting the owner
      }
    })()
  }, 15000)
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
  // backup and restore
  [IPC.createBackup]: (async () => (await phoneBackup?.create()) ?? null) as Handler,
  [IPC.listBackups]: (async () => (await phoneBackup?.list()) ?? []) as Handler,
  [IPC.restoreBackup]: (() => restoreInteractive()) as Handler,
  [IPC.exportLibrary]: (() => exportLibraryFile()) as Handler,
  [IPC.importLibrary]: (async () => {
    const bytes = await pickFileBytes()
    return bytes && phoneBackup ? phoneBackup.restoreBytes(bytes) : false
  }) as Handler,
  // tag editing
  [IPC.editMetadata]: ((songId: string, edits: Record<string, unknown>) =>
    core.editSong(songId, edits, async (path, tags) => {
      const plugin = getDownloadPlugin()
      return plugin ? (await plugin.writeTags({ path, tags })).written : false
    })) as Handler,
  [IPC.refreshMetadata]: (async (songId: string) => {
    const loc = core.phone.songLocation(songId)
    if (!loc || !phoneLib) return false
    await phoneLib.describeFile(songId, loc.path)
    return true
  }) as Handler,
  // downloads
  [IPC.getDownloads]: () => queue?.list() ?? [],
  [IPC.cancelDownload]: ((id: string) => {
    queue?.cancel(id)
    return null
  }) as Handler,
  [IPC.removeDownload]: ((id: string) => {
    queue?.remove(id)
    return null
  }) as Handler,
  [IPC.clearCompleted]: () => {
    queue?.clearCompleted()
    return null
  },
  [IPC.clearPending]: () => queue?.clearPending() ?? 0,
  [IPC.pauseAllDownload]: () => queue?.pauseAll() ?? 0,
  [IPC.resumeAllDownload]: () => queue?.resumeAll() ?? 0,
  [IPC.pauseDownload]: ((id: string) => {
    queue?.pause(id)
    return null
  }) as Handler,
  [IPC.resumeDownload]: ((id: string) => {
    queue?.resume(id)
    return null
  }) as Handler,
  [IPC.retryDownload]: ((id: string) => {
    queue?.retry(id)
    return null
  }) as Handler,
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
  void startDownloads()
  void startBackups()
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
