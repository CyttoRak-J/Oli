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
import { Browser } from '@capacitor/browser'
import { deviceFileUrl } from '../lib/platform'
import { setStreamHeaders } from './nativeAudio'
import { initAndroidCore, trackIds, type AndroidCore, type AndroidProviders } from './androidCore'
import { YouTubeService, getYouTubePlugin } from './youtubeService'
import { songTagsFor, videoIdFromUrl, isYouTubeUrl, type SongTags } from './youtubeCore'
import { getMediaPlugin, isPhoneLocation, PhoneLibrary } from './phoneLibrary'
import { checkAndroidUpdate, type AndroidUpdateStatus } from './androidUpdate'
import { PhoneBackup, base64ToBytes, bytesToBase64, pickFileBytes, type BackupStorage } from './phoneBackup'
import {
  DownloadQueue,
  getDownloadPlugin,
  type CompletedFile,
  type DownloadEnqueue,
  type DownloadJob,
  type DownloadStore
} from './downloadQueue'

type Handler = (...args: never[]) => unknown
type Listener = (...args: unknown[]) => void

const DOWNLOADS_KEY = 'oli.downloads'
/** The installed Android version (from android/app/build.gradle at build time). */
const APP_VERSION = typeof __OLI_ANDROID_VERSION__ === 'string' ? __OLI_ANDROID_VERSION__ : '0.0.0'

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
/** YouTube (yt-dlp on the phone); null in a plain browser. */
let yt: YouTubeService | null = null
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

/** "Reveal in Explorer" on the phone: open the Files app at the folder, or say where the file is. */
async function revealOnPhone(uri: string): Promise<boolean> {
  const plugin = getMediaPlugin()
  if (!plugin || !uri) return false
  try {
    const r = await plugin.revealFile({ uri })
    if (!r.opened) {
      window.alert(
        r.path
          ? `Android does not let a file app open this folder.\n\nThe file is in:\n${r.path}`
          : 'Oli could not find where this file is.'
      )
    }
    return r.opened
  } catch {
    return false
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

interface YouTubeJobMeta {
  kind: 'youtube'
  duration: number | null
  thumbnail: string | null
}
interface FileJobMeta {
  kind: 'file'
  title: string
}

/** A song row for a file that is not from the Internet Archive (a YouTube download, a direct link). */
function makeSimpleTrack(tags: SongTags, path: string, size: number, durationSec: number | null): Track {
  const now = Date.now()
  const ext = (path.split('.').pop() ?? '').toLowerCase().slice(0, 8)
  const codec = ext === 'm4a' || ext === 'mp4' || ext === 'aac' ? 'aac' : ext === 'webm' || ext === 'opus' ? 'opus' : ext === 'flac' ? 'flac' : ext === 'mp3' ? 'mp3' : null
  const artist = tags.artist || 'Unknown Artist'
  const album = tags.album || 'Unknown Album'
  return {
    id: trackIds.songIdForPath(path),
    title: tags.title || 'Untitled',
    artist,
    artistId: trackIds.artistIdFor(artist),
    albumArtist: artist,
    album,
    albumId: trackIds.albumIdFor('', album),
    genre: null,
    composer: null,
    year: null,
    releaseDate: null,
    trackNo: null,
    discNo: null,
    isrc: null,
    rating: null,
    duration: durationSec ?? 0,
    bitrate: null,
    sampleRate: null,
    bitDepth: null,
    channels: null,
    codec,
    format: ext ? ext.toUpperCase() : null,
    fileSize: size,
    path,
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

/** A finished file becomes a song; its real format is read from the file. */
async function downloadCompleted(_d: DownloadItem, job: DownloadJob, file: CompletedFile): Promise<void> {
  const meta = job.meta as ArchiveJobMeta | YouTubeJobMeta | FileJobMeta | undefined
  if (!meta) return
  let track: Track | null = null
  if ('file' in meta) {
    track = makeTrack(meta.file, meta.item, file.path, file.size)
  } else if (meta.kind === 'youtube' && job.youtube?.mode === 'song') {
    const y = job.youtube
    track = makeSimpleTrack({ title: y.title, artist: y.artist, album: y.album }, file.path, file.size, meta.duration)
  } else if (meta.kind === 'file') {
    track = makeSimpleTrack({ title: meta.title, artist: '', album: '' }, file.path, file.size, null)
  }
  if (!track) return // a downloaded video is a file in the app folder, not a song
  core.upsertTrack(track)
  await phoneLib?.describeFile(track.id, file.path)
}

async function startDownloads(): Promise<void> {
  const plugin = getDownloadPlugin()
  if (!plugin) return
  // How many YouTube songs download at once is a setting; on the phone 2 is the default (it was fixed at 2 before).
  const ytPlugin = getYouTubePlugin()
  const applyConcurrency = (n: unknown): void => {
    const count = Math.max(1, Math.min(6, Number(n) || 2))
    void ytPlugin?.setConcurrency({ count }).catch(() => undefined)
  }
  try {
    const s = (await core.handlers[IPC.getSettings]()) as { ytConcurrency?: number }
    if (localStorage.getItem('oli.ytConcurrencySet') !== '1') {
      localStorage.setItem('oli.ytConcurrencySet', '1')
      if ((s.ytConcurrency ?? 1) <= 1) await core.handlers[IPC.setSettings]({ ytConcurrency: 2 } as never)
    }
    applyConcurrency(((await core.handlers[IPC.getSettings]()) as { ytConcurrency?: number }).ytConcurrency)
  } catch {
    // keep the native default
  }
  window.cytto.on(IPC.onSettingsChanged, (patch) => {
    if (patch && typeof patch === 'object' && 'ytConcurrency' in patch) applyConcurrency((patch as { ytConcurrency?: number }).ytConcurrency)
  })
  queue = new DownloadQueue({
    plugin,
    youtube: getYouTubePlugin() ?? undefined,
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

// ------------------------------------------------------------------ YouTube (see youtubeService.ts)
const YT_ENGINE_LATEST = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest'
const watchUrl = (id: string): string => `https://www.youtube.com/watch?v=${id}`

async function latestYtdlp(): Promise<string | null> {
  try {
    const res = await fetch(YT_ENGINE_LATEST, { headers: { Accept: 'application/vnd.github+json' } })
    if (!res.ok) return null
    const tag = ((await res.json()) as { tag_name?: string }).tag_name
    return tag ?? null
  } catch {
    return null
  }
}

async function startYouTube(): Promise<void> {
  const plugin = getYouTubePlugin()
  if (!plugin) return
  const svc = new YouTubeService({
    plugin,
    latestVersion: latestYtdlp,
    setStreamHeaders,
    emitStatus: (st) => emit(IPC.onYtEngineStatus, st),
    autoUpdate: () => (core.handlers[IPC.getSettings]() as { ytdlpAutoUpdate?: boolean }).ytdlpAutoUpdate !== false
  })
  yt = svc
  // The first start unpacks Python (seconds); then look for a newer yt-dlp at most once a day.
  await svc.start()
  const last = Number(readJson<number>('oli.ytdlpCheckedAt', 0))
  if (Date.now() - last > 24 * 3600 * 1000) {
    writeJson('oli.ytdlpCheckedAt', Date.now())
    void svc.check()
  }
}

/** Queue entries for YouTube songs or videos. */
function youtubeEntries(
  list: Array<{ videoId: string; title: string; duration?: number; channel?: string | null; track?: { name: string; artists: string[]; album: string | null } }>,
  mode: 'song' | 'video',
  audio: string,
  height: number,
  withPrepare = false
): DownloadEnqueue[] {
  return list.map((e) => {
    const channel = e.channel ?? yt?.channelOf(e.videoId) ?? null
    const tags = songTagsFor(e.title, channel, e.track ? { track: e.track.name, artist: e.track.artists.join(', '), album: e.track.album } : null)
    const relBase =
      mode === 'video'
        ? `Oli/Videos/${safeName(e.title)} [${e.videoId}]`
        : `Oli/YouTube/${safeName(`${tags.artist} - ${tags.title}`)} [${e.videoId}]`
    const meta: YouTubeJobMeta = { kind: 'youtube', duration: e.duration ?? null, thumbnail: null }
    return {
      title: mode === 'video' ? e.title : tags.title,
      job: {
        url: watchUrl(e.videoId),
        relPath: relBase,
        size: 0,
        md5: '',
        youtube: { videoId: e.videoId, mode, audio, height, relBase, title: tags.title, artist: tags.artist, album: tags.album },
        meta
      } satisfies DownloadJob,
      // a single song: read the video's own tags first (YouTube Music uploads have exact ones)
      prepare:
        withPrepare && mode === 'song' && yt
          ? async () => {
              const m = await yt!.meta(e.videoId)
              if (!m) return null
              const t = songTagsFor(m.title, m.channel, m)
              return { title: t.title, youtube: { title: t.title, artist: t.artist, album: t.album, relBase: `Oli/YouTube/${safeName(`${t.artist} - ${t.title}`)} [${e.videoId}]` }, meta: { kind: 'youtube', duration: m.duration, thumbnail: m.thumbnail } satisfies YouTubeJobMeta }
            }
          : undefined
    }
  })
}

function audioChoice(a: unknown): string {
  return a === 'm4a' || a === 'opus' ? a : 'best'
}

const youtubeHandlers: Record<string, Handler> = {
  [IPC.ytEngineInfo]: (() => yt?.getStatus() ?? engineStatus) as Handler,
  [IPC.ytEngineCheck]: (() => (yt ? yt.check() : engineStatus)) as Handler,
  [IPC.ytEngineUpdate]: (() => (yt ? yt.install() : engineStatus)) as Handler,
  [IPC.resolveYouTubeStream]: ((videoId: string, fresh?: boolean) => yt?.resolveStream(videoId, fresh === true) ?? []) as Handler,
  [IPC.resolveYouTubeStreamBatch]: ((ids: string[]) => yt?.resolveStreamBatch(Array.isArray(ids) ? ids : []) ?? []) as Handler,
  [IPC.prefetchYouTubeStreams]: ((ids: string[], priority?: boolean) => {
    if (Array.isArray(ids)) yt?.prefetch(ids.filter((i) => typeof i === 'string').slice(0, 12), priority === true)
    return null
  }) as Handler,
  [IPC.resolveYouTubeUrl]: ((url: string) => yt?.resolveUrl(String(url)) ?? []) as Handler,
  [IPC.resolvePlaylistEntries]: (async (url: string) => {
    if (!yt) return { entries: [], error: 'YouTube is not available in this build of the app.' }
    return yt.playlistEntries(String(url))
  }) as Handler,
  // the PC plays the audio of a video that refuses to stream by downloading it first; here the stream is all there is
  [IPC.downloadYouTubeAudio]: (() => null) as Handler,
  [IPC.videoFallbackUrl]: (() => null) as Handler,
  [IPC.openVideoWindow]: (() => false) as Handler,
  [IPC.videoRetry]: (() => false) as Handler,
  [IPC.videoDownloadSong]: (async (videoId: string, audio?: string) => {
    if (!queue || !yt || !videoId) return null
    const title = 'YouTube song'
    const entries = youtubeEntries([{ videoId, title }], 'song', audioChoice(audio), 0, true)
    entries[0].title = title
    queue.add(entries)
    return queue.list().find((d) => d.url === watchUrl(videoId))?.id ?? null
  }) as Handler,
  [IPC.videoDownload]: (async (videoId: string, height?: number, audio?: string) => {
    if (!queue || !yt || !videoId) return null
    const entries = youtubeEntries([{ videoId, title: 'YouTube video' }], 'video', audioChoice(audio), Number(height) || 0)
    queue.add(entries)
    const id = queue.list().find((d) => d.url === watchUrl(videoId))?.id ?? null
    void yt.meta(videoId).then((m) => id && m && queue?.updateTitle(id, m.title))
    return id
  }) as Handler,
  [IPC.enqueuePlaylist]: (async (url: string, audio?: string) => {
    if (!queue || !yt) return { found: 0, enqueued: 0, error: 'YouTube is not available in this build of the app.' }
    const r = await yt.playlistEntries(String(url))
    if (r.entries.length === 0) return { found: 0, enqueued: 0, error: r.error }
    const n = queue.add(youtubeEntries(r.entries, 'song', audioChoice(audio), 0))
    return { found: r.entries.length, enqueued: n, capped: r.capped }
  }) as Handler,
  [IPC.enqueueEntries]: ((entries: Array<{ videoId: string; title: string; duration?: number; track?: { name: string; artists: string[]; album: string | null } }>, opts?: { mode?: string; audio?: string; height?: number }) => {
    if (!queue || !yt || !Array.isArray(entries)) return { found: 0, enqueued: 0 }
    const clean = entries.filter((x) => x && typeof x.videoId === 'string' && typeof x.title === 'string').slice(0, 2000)
    const mode = opts?.mode === 'video' ? 'video' : 'song'
    return { found: clean.length, enqueued: queue.add(youtubeEntries(clean, mode, audioChoice(opts?.audio), Number(opts?.height) || 0)) }
  }) as Handler,
  // a pasted address: a YouTube link becomes a song download, any other http(s) link a plain file download
  [IPC.enqueueDownload]: (async (url: string, title?: string) => {
    if (!queue || typeof url !== 'string') return null
    const u = url.trim()
    const before = new Set(queue.list().map((d) => d.id))
    if (isYouTubeUrl(u)) {
      const id = videoIdFromUrl(u)
      if (!id || !yt) return null
      queue.add(youtubeEntries([{ videoId: id, title: (title ?? '').trim() || 'YouTube song' }], 'song', 'best', 0, true))
    } else if (/^https?:\/\//i.test(u)) {
      const name = decodeURIComponent(u.split('?')[0].split('/').pop() ?? '') || 'download'
      const dot = name.lastIndexOf('.')
      const ext = dot > 0 ? name.slice(dot, dot + 9) : ''
      const label = (title ?? '').trim() || (dot > 0 ? name.slice(0, dot) : name)
      queue.add([{ title: label, job: { url: u, relPath: `Oli/Downloads/${safeName(label)}${ext}`, size: 0, md5: '', meta: { kind: 'file', title: label } satisfies FileJobMeta } }])
    } else {
      return null
    }
    return queue.list().find((d) => !before.has(d.id)) ?? null
  }) as Handler
}

// ------------------------------------------------------------------ app updates (see androidUpdate.ts)
let lastUpdate: AndroidUpdateStatus | null = null
async function checkForAndroidUpdate(auto: boolean): Promise<AndroidUpdateStatus> {
  // an automatic check at most every 6 hours, like the PC app; the last answer is reused in between
  if (auto && lastUpdate && Date.now() - lastUpdate.checkedAt < 6 * 3600 * 1000) return lastUpdate
  lastUpdate = await checkAndroidUpdate(APP_VERSION)
  return lastUpdate
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
  ...youtubeHandlers,
  // app and window
  [IPC.getAppInfo]: () => ({ name: 'Oli', version: APP_VERSION, electron: 'n/a (Android)', chrome: navigator.userAgent, node: 'n/a' }),
  [IPC.windowControl]: noop,
  [IPC.getWindowState]: () => ({ maximized: true, fullscreen: false }),
  [IPC.checkForUpdates]: ((auto?: boolean) => checkForAndroidUpdate(auto === true)) as Handler,
  [IPC.openReleasePage]: ((url?: string) => {
    // only the project's own release pages are opened (in the phone's browser)
    const target = typeof url === 'string' && url.startsWith('https://github.com/CyttoRak-J/Oli/') ? url : 'https://github.com/CyttoRak-J/Oli/releases'
    void Browser.open({ url: target }).catch(() => undefined)
    return null
  }) as Handler,
  // the phone's own music (MediaStore through the native OliMedia plugin, see phoneLibrary.ts)
  [IPC.getScanState]: () => phoneLib?.getState() ?? null,
  // 'all' = every song MediaStore lists; otherwise Android's folder picker ('replace' = the owner agreed to leave "all music")
  [IPC.addLibraryFolder]: (async (mode?: 'all' | 'folder' | 'replace') => {
    if (!phoneLib) return null
    if (mode === 'all') {
      if (!(await phoneLib.addAndScan())) return null
    } else {
      const res = await phoneLib.addFolder(mode === 'replace')
      if (res.status !== 'added') return res.status === 'needs-replace' ? 'needs-replace' : null
    }
    return core.handlers[IPC.getLibrary]()
  }) as Handler,
  [IPC.removeLibraryFolder]: ((id: string) => {
    if (isPhoneLocation(id)) phoneLib?.remove(id)
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
  [IPC.revealInExplorer]: (async (uri: string) => revealOnPhone(uri)) as Handler,
  [IPC.getMediaBase]: () => '',
  [IPC.probeDuration]: noop,
  [IPC.transcodeLocalFile]: noop,
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
  [IPC.revealDownload]: (async (id: string) => {
    const item = queue?.list().find((d) => d.id === id)
    return item?.destPath ? revealOnPhone(item.destPath) : false
  }) as Handler,
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
  const providers: AndroidProviders = {
    isSpotifyConfigured: () => false,
    isYouTubeConfigured: () => yt !== null,
    searchSpotify: async () => [],
    searchYouTube: async (query: string) => (yt ? yt.search(query) : []),
    status: () => ({ spotifyConfigured: false, youtubeConfigured: yt !== null })
  } as never
  core = await initAndroidCore(providers)
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
  void startYouTube()
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
  const hasLocation = (core.handlers[IPC.getLibrary]() as Array<{ id: string }>).some((f) => isPhoneLocation(f.id))
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
