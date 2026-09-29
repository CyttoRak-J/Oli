/**
 * The phone's own music as a library location: lists the audio files Android's MediaStore knows through the native
 * `OliMedia` plugin, turns them into the same `Track` rows the desktop scanner makes (same id scheme), keeps the
 * database in step (added / changed / removed songs), then reads the details MediaStore does not have (real sample rate
 * and bit depth, ReplayGain, ISRC, lyrics) in the background. Cover art is extracted lazily and cached natively.
 *
 * The logic here talks to the plugin and to a small `PhoneStore` interface only, so it is unit-tested with fakes.
 */
import { albumIdFor, artistIdFor, hash64, songIdForPath } from '@main/util/identity'
import type { ScanProgress, Track } from '@shared/types'

export const PHONE_LIBRARY_ID = 'phone:mediastore'
export const PHONE_LIBRARY_PATH = 'Phone music'

// ------------------------------------------------------------------ plugin (native side)
export interface MediaRow {
  id: number
  uri: string
  title: string
  artist: string
  album: string
  albumArtist: string
  composer: string
  genre: string
  year: number
  trackNo: number
  discNo: number
  durationMs: number
  size: number
  modifiedSec: number
  addedSec: number
  displayName: string
  mime: string
  bitrate: number
  /** Folder + file name; stable when Android renumbers its own ids. */
  key: string
}

export interface ProbeResult {
  uri: string
  sampleRate?: number
  channels?: number
  bitDepth?: number
  container?: string
  mime?: string
  trackGain?: string
  albumGain?: string
  isrc?: string
  lyrics?: string
  composer?: string
  genre?: string
  discNumber?: string
  error?: string
}

interface ListenerHandle {
  remove(): Promise<void> | void
}

export interface OliMediaPlugin {
  getPermission(): Promise<{ granted: boolean }>
  requestPermission(): Promise<{ granted: boolean }>
  queryAudio(o: { offset: number; limit: number }): Promise<{ rows: MediaRow[]; total?: number }>
  probeFiles(o: { uris: string[] }): Promise<{ results: ProbeResult[] }>
  getArtwork(o: { uri: string; key: string; size?: number }): Promise<{ path?: string }>
  clearArtworkCache(): Promise<void>
  addListener(event: string, cb: (data: never) => void): Promise<ListenerHandle> | ListenerHandle
}

// ------------------------------------------------------------------ database side
export interface PhoneSongRow {
  id: string
  modifiedAt: number
  missing: boolean
  /** null = the file's details were never read; 0 = read, nothing found. */
  sampleRate: number | null
  path: string
}

export interface SongPatch {
  sampleRate?: number
  bitDepth?: number | null
  channels?: number | null
  codec?: string | null
  replayGain?: number | null
  replayGainAlbum?: number | null
  isrc?: string | null
  lyrics?: string | null
  discNo?: number | null
  composer?: string | null
  genre?: string | null
}

/** What the scanner needs from the database (implemented in androidCore.ts). */
export interface PhoneStore {
  ensureLocation(id: string, path: string, name: string): void
  removeLocation(id: string): void
  songsOf(libraryId: string): PhoneSongRow[]
  upsertTracks(tracks: Track[]): void
  markMissing(ids: string[]): void
  patchSongs(patches: Array<{ id: string; patch: SongPatch }>): void
  /** Rebuild artists/albums, stamp the scan time, tell the screens, save the database. */
  finish(libraryId: string): void
  songLocation(id: string): { path: string; albumId: string | null } | undefined
}

// ------------------------------------------------------------------ mapping (MediaStore row -> Track)
const UNKNOWN = '<unknown>'

const clean = (s: string | undefined | null): string => {
  const t = (s ?? '').trim()
  return t === UNKNOWN ? '' : t
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase().slice(0, 8) : ''
}

/** Short codec name from a MIME type ("" when unknown). */
export function codecFromMime(mime: string | undefined | null): string {
  const m = (mime ?? '').toLowerCase()
  if (m.includes('flac')) return 'flac'
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3'
  if (m.includes('alac')) return 'alac'
  if (m.includes('opus')) return 'opus'
  if (m.includes('vorbis') || m.includes('ogg')) return 'vorbis'
  if (m.includes('mp4a') || m.includes('aac') || m.includes('mp4') || m.includes('m4a')) return 'aac'
  if (m.includes('wav') || m.includes('wave') || m.includes('raw')) return 'pcm'
  if (m.includes('wma') || m.includes('ms-wma')) return 'wma'
  if (m.includes('amr')) return 'amr'
  return ''
}

/** "-7.23 dB" -> -7.23 (null when it is not a number). */
export function parseGain(s: string | undefined | null): number | null {
  if (!s) return null
  const n = Number.parseFloat(s.replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

/** The row's song id: the same cyrb64 scheme as the desktop, over the folder + file name. */
export function phoneSongId(row: MediaRow): string {
  return songIdForPath(row.key || row.uri)
}

export function rowToTrack(row: MediaRow, libraryId: string = PHONE_LIBRARY_ID): Track {
  const name = row.displayName || ''
  const ext = extensionOf(name)
  const stem = ext ? name.slice(0, name.length - ext.length - 1) : name
  const title = clean(row.title) || stem || 'Untitled'
  const artist = clean(row.artist) || 'Unknown Artist'
  const album = clean(row.album) || 'Unknown Album'
  const albumArtistTag = clean(row.albumArtist)
  const rel = (row.key || '').slice(0, Math.max(0, (row.key || '').length - name.length))
  const year = row.year > 0 ? row.year : null
  return {
    id: phoneSongId(row),
    title,
    artist,
    artistId: artistIdFor(artist),
    albumArtist: albumArtistTag || artist,
    album,
    albumId: albumIdFor(albumArtistTag, album),
    genre: clean(row.genre) || null,
    composer: clean(row.composer) || null,
    year,
    releaseDate: year ? String(year) : null,
    trackNo: row.trackNo > 0 ? row.trackNo : null,
    discNo: row.discNo > 0 ? row.discNo : null,
    isrc: null,
    rating: null,
    duration: row.durationMs > 0 ? row.durationMs / 1000 : 0,
    bitrate: row.bitrate > 0 ? row.bitrate : null,
    sampleRate: null,
    bitDepth: null,
    channels: null,
    codec: codecFromMime(row.mime) || null,
    format: ext || null,
    fileSize: row.size > 0 ? row.size : null,
    path: row.uri,
    folderId: rel ? `dir:${hash64(rel)}` : null,
    libraryId,
    hash: null,
    replayGain: null,
    replayGainAlbum: null,
    lyrics: null,
    hasEmbeddedArtwork: false,
    addedAt: row.addedSec > 0 ? row.addedSec * 1000 : Date.now(),
    modifiedAt: row.modifiedSec * 1000,
    lastPlayedAt: null,
    playCount: 0,
    favorite: false,
    missing: false,
    error: null
  }
}

export function probeToPatch(p: ProbeResult, current: { codec?: string | null }): SongPatch {
  const lossy = ['mp3', 'aac', 'opus', 'vorbis', 'wma', 'amr'].includes(codecFromMime(p.mime) || (current.codec ?? ''))
  const patch: SongPatch = { sampleRate: p.error ? 0 : (p.sampleRate ?? 0) }
  if (p.channels && p.channels > 0) patch.channels = p.channels
  if (p.bitDepth && p.bitDepth > 0 && !lossy) patch.bitDepth = p.bitDepth
  const codec = p.container === 'flac' ? 'flac' : p.container === 'wav' ? 'pcm' : codecFromMime(p.mime)
  if (codec) patch.codec = codec
  const tg = parseGain(p.trackGain)
  const ag = parseGain(p.albumGain)
  if (tg != null) patch.replayGain = tg
  if (ag != null) patch.replayGainAlbum = ag
  if (p.isrc) patch.isrc = p.isrc
  if (p.lyrics) patch.lyrics = p.lyrics
  const disc = Number.parseInt(p.discNumber ?? '', 10)
  if (Number.isFinite(disc) && disc > 0) patch.discNo = disc
  if (p.composer) patch.composer = p.composer
  if (p.genre) patch.genre = p.genre
  return patch
}

// ------------------------------------------------------------------ the scanner
const PAGE = 500
const UPSERT_BATCH = 200
const PROBE_BATCH = 20

export interface PhoneLibraryOptions {
  plugin: OliMediaPlugin
  store: PhoneStore
  emitProgress: (p: ScanProgress) => void
  /** Called when a background pass changed songs (cover cache etc. may want a refresh). */
  now?: () => number
}

const idle = (): ScanProgress => ({
  libraryId: PHONE_LIBRARY_ID,
  phase: 'idle',
  currentFile: null,
  filesFound: 0,
  filesProcessed: 0,
  filesAdded: 0,
  filesUpdated: 0,
  filesRemoved: 0,
  skippedUnsupported: 0,
  skippedDuplicates: 0,
  itemsWithErrors: 0,
  message: null
})

export class PhoneLibrary {
  private state: ScanProgress = idle()
  private running: Promise<void> | null = null
  private again = false
  private canceled = false
  private lastAutoScanAt = 0
  private artCache = new Map<string, string | null>()
  private artInflight = new Map<string, Promise<string | null>>()

  constructor(private opts: PhoneLibraryOptions) {}

  getState(): ScanProgress {
    return { ...this.state }
  }

  cancel(): void {
    this.canceled = true
  }

  private set(patch: Partial<ScanProgress>): void {
    this.state = { ...this.state, ...patch }
    this.opts.emitProgress({ ...this.state })
  }

  /** Ask for the permission if needed. */
  async ensurePermission(): Promise<boolean> {
    try {
      const cur = await this.opts.plugin.getPermission()
      if (cur.granted) return true
      return (await this.opts.plugin.requestPermission()).granted
    } catch {
      return false
    }
  }

  /** Add the "Phone music" location (asking for the permission) and scan it. Returns false when access was refused. */
  async addAndScan(): Promise<boolean> {
    if (!(await this.ensurePermission())) {
      this.set({ ...idle(), phase: 'error', message: 'Oli needs permission to read your music. Allow it and try again.' })
      return false
    }
    this.opts.store.ensureLocation(PHONE_LIBRARY_ID, PHONE_LIBRARY_PATH, 'Phone music')
    void this.scan()
    return true
  }

  remove(): void {
    this.opts.store.removeLocation(PHONE_LIBRARY_ID)
    this.artCache.clear()
    void this.opts.plugin.clearArtworkCache().catch(() => undefined)
  }

  /** A scan at most every 30 s when Android reports changes (like the desktop folder watcher). */
  onMediaChanged(): void {
    const t = Date.now()
    if (this.running || t - this.lastAutoScanAt < 30_000) return
    this.lastAutoScanAt = t
    void this.scan()
  }

  /** Resolves when no scan is running or waiting (a scan asked for during a scan runs right after it). */
  async whenIdle(): Promise<void> {
    while (this.running) await this.running.catch(() => undefined)
  }

  /** Runs one scan; a request while one runs is remembered and runs afterwards. */
  scan(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.canceled = false
    this.running = this.run().finally(() => {
      this.running = null
      if (this.again) {
        this.again = false
        void this.scan()
      }
    })
    return this.running
  }

  private async run(): Promise<void> {
    const { plugin, store } = this.opts
    this.state = idle()
    this.set({ phase: 'discovering', message: 'Looking for music on this phone…' })
    try {
      if (!(await this.ensurePermission())) {
        this.set({ phase: 'error', message: 'Oli needs permission to read your music.' })
        return
      }
      store.ensureLocation(PHONE_LIBRARY_ID, PHONE_LIBRARY_PATH, 'Phone music')
      const existing = new Map(store.songsOf(PHONE_LIBRARY_ID).map((r) => [r.id, r]))

      // 1. list everything MediaStore has, page by page
      const rows: MediaRow[] = []
      for (let offset = 0; ; offset += PAGE) {
        if (this.canceled) return this.finishCanceled()
        const page = await plugin.queryAudio({ offset, limit: PAGE })
        rows.push(...page.rows)
        this.set({ filesFound: rows.length })
        if (page.rows.length < PAGE) break
      }

      // 2. new / changed songs go into the database; unchanged ones are left alone
      this.set({ phase: 'reading', message: null })
      const seen = new Set<string>()
      let batch: Track[] = []
      let added = 0
      let updated = 0
      let processed = 0
      const flushBatch = (): void => {
        if (batch.length === 0) return
        store.upsertTracks(batch)
        batch = []
      }
      for (const row of rows) {
        if (this.canceled) {
          flushBatch()
          return this.finishCanceled()
        }
        const t = rowToTrack(row)
        seen.add(t.id)
        const old = existing.get(t.id)
        if (!old) {
          added++
          batch.push(t)
        } else if (old.modifiedAt !== t.modifiedAt || old.missing || old.path !== t.path) {
          updated++
          batch.push(t)
        }
        processed++
        if (batch.length >= UPSERT_BATCH) {
          flushBatch()
          this.set({ filesProcessed: processed, filesAdded: added, filesUpdated: updated, currentFile: t.title })
          await tick()
        }
      }
      flushBatch()

      // 3. songs that vanished from the phone are marked missing (playlists keep them, as on the desktop)
      const gone: string[] = []
      for (const [id, r] of existing) if (!seen.has(id) && !r.missing) gone.push(id)
      if (gone.length > 0) store.markMissing(gone)
      this.set({ filesProcessed: processed, filesAdded: added, filesUpdated: updated, filesRemoved: gone.length })
      store.finish(PHONE_LIBRARY_ID) // the songs are visible now; details follow in the background

      // 4. read the real format / tags of songs whose details were never read
      const todo = store
        .songsOf(PHONE_LIBRARY_ID)
        .filter((r) => !r.missing && r.sampleRate === null)
      if (todo.length > 0) {
        this.set({ phase: 'indexing', filesFound: todo.length, filesProcessed: 0, currentFile: null })
        let done = 0
        let errors = 0
        for (let i = 0; i < todo.length; i += PROBE_BATCH) {
          if (this.canceled) break
          const chunk = todo.slice(i, i + PROBE_BATCH)
          let results: ProbeResult[] = []
          try {
            results = (await plugin.probeFiles({ uris: chunk.map((r) => r.path) })).results
          } catch {
            errors += chunk.length
          }
          const byUri = new Map(results.map((r) => [r.uri, r]))
          const patches = chunk.map((r) => {
            const p = byUri.get(r.path) ?? { uri: r.path, error: 'no answer' }
            if (p.error) errors++
            return { id: r.id, patch: probeToPatch(p, {}) }
          })
          store.patchSongs(patches)
          done += chunk.length
          this.set({ filesProcessed: done, itemsWithErrors: errors })
          await tick()
        }
        store.finish(PHONE_LIBRARY_ID)
      }
      this.set({ phase: 'finished', message: `${rows.length} songs on this phone` })
    } catch (err) {
      const msg = String((err as Error)?.message ?? err)
      this.set({ phase: 'error', message: msg === 'permission' ? 'Oli needs permission to read your music.' : msg })
    }
  }

  private finishCanceled(): void {
    this.opts.store.finish(PHONE_LIBRARY_ID)
    this.set({ phase: 'finished', canceled: true, message: 'Scan stopped' })
  }

  /**
   * File URL of the cover for a song (embedded art, or the folder cover Android knows), extracted natively into a
   * cache; songs of one album share one file. `toUrl` turns a device path into something the web view can load.
   */
  artworkFor(songId: string, toUrl: (path: string) => string): Promise<string | null> {
    const loc = this.opts.store.songLocation(songId)
    if (!loc) return Promise.resolve(null)
    const key = loc.albumId ?? songId
    if (this.artCache.has(key)) return Promise.resolve(this.artCache.get(key) ?? null)
    const pending = this.artInflight.get(key)
    if (pending) return pending
    const p = this.opts.plugin
      .getArtwork({ uri: loc.path, key, size: 600 })
      .then((r) => (r.path ? toUrl(r.path) : null))
      .catch(() => null)
      .then((url) => {
        this.artCache.set(key, url)
        this.artInflight.delete(key)
        return url
      })
    this.artInflight.set(key, p)
    return p
  }
}

/** Lets the screen breathe between batches. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

// ------------------------------------------------------------------ access from the app
interface CapacitorGlobal {
  getPlatform?: () => string
  registerPlugin?: <T>(name: string) => T
  PluginHeaders?: Array<{ name: string }>
}

let mediaProxy: OliMediaPlugin | null = null

/** The native media plugin, or null when this is not the Android app (or the APK has no OliMedia plugin). */
export function getMediaPlugin(): OliMediaPlugin | null {
  if (mediaProxy) return mediaProxy
  if (typeof window === 'undefined') return null
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor
  if (!cap || cap.getPlatform?.() !== 'android' || !cap.registerPlugin) return null
  if (Array.isArray(cap.PluginHeaders) && !cap.PluginHeaders.some((h) => h.name === 'OliMedia')) return null
  mediaProxy = cap.registerPlugin<OliMediaPlugin>('OliMedia')
  return mediaProxy
}
