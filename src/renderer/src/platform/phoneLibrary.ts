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

// ------------------------------------------------------------------ chosen folders
/** A folder on the phone's storage or a memory card (from Android's folder picker). "" = the whole volume. */
export interface PhoneScope {
  volume: string
  path: string
}

const FOLDER_PREFIX = 'phone:dir:'

/** One library location per chosen folder; the id carries the folder so nothing else has to be stored. */
export const folderLocationId = (s: PhoneScope): string => `${FOLDER_PREFIX}${s.volume}|${s.path}`

/** The folder a location stands for; null for "all the phone's music" (and for anything that is not a phone location). */
export function scopeOfLocation(id: string): PhoneScope | null {
  if (!id.startsWith(FOLDER_PREFIX)) return null
  const rest = id.slice(FOLDER_PREFIX.length)
  const bar = rest.indexOf('|')
  return bar < 0 ? null : { volume: rest.slice(0, bar), path: rest.slice(bar + 1) }
}

export const isPhoneLocation = (id: string): boolean => id === PHONE_LIBRARY_ID || id.startsWith(FOLDER_PREFIX)

/** Is folder `inner` the same as, or inside, folder `outer`? (Android's folder names ignore capitals.) */
export function scopeContains(outer: PhoneScope, inner: PhoneScope): boolean {
  if (outer.volume.toLowerCase() !== inner.volume.toLowerCase()) return false
  const o = outer.path.toLowerCase()
  const i = inner.path.toLowerCase()
  return o === '' || i === o || i.startsWith(`${o}/`)
}

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
  /** With a volume (and path) only the music inside that folder is listed. */
  queryAudio(o: { offset: number; limit: number; volume?: string; path?: string }): Promise<{ rows: MediaRow[]; total?: number }>
  /** Android's folder picker. */
  pickFolder(): Promise<{ cancelled?: boolean; volume?: string; path?: string; label?: string }>
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
  /** Removes a location together with its songs. */
  removeLocation(id: string): void
  /** The phone-music locations (all the phone's music, or chosen folders), oldest first. */
  locations(): Array<{ id: string; path: string }>
  /** Moves songs into another location (they keep their favorites, play counts and details). */
  adoptSongs(ids: string[], toId: string): void
  songsOf(libraryId: string): PhoneSongRow[]
  upsertTracks(tracks: Track[]): void
  markMissing(ids: string[]): void
  patchSongs(patches: Array<{ id: string; patch: SongPatch }>): void
  /** Rebuild artists/albums, stamp the scan time, tell the screens, save the database. */
  finish(libraryId: string): void
  songLocation(id: string): { path: string; albumId: string | null } | undefined
  /** Codec of each song (from the media library's file type). */
  codecsOf(ids: string[]): Map<string, string>
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
    const { store } = this.opts
    const folders = store.locations().filter((l) => l.id !== PHONE_LIBRARY_ID)
    store.ensureLocation(PHONE_LIBRARY_ID, PHONE_LIBRARY_PATH, 'Phone music')
    if (folders.length > 0) {
      // "all music" takes over the chosen folders' songs, so favorites and play counts survive
      try {
        store.adoptSongs(await this.songIdsIn(null), PHONE_LIBRARY_ID)
      } catch {
        // the scan below adds whatever is missing
      }
      for (const f of folders) store.removeLocation(f.id)
    }
    void this.scan()
    return true
  }

  /**
   * Lets the owner pick a folder (Android's folder picker) and scans it, like "Add folders" on the PC. A folder inside one
   * that is already scanned is not added twice; a folder that contains chosen folders takes them over.
   */
  async addFolder(replaceAll = false): Promise<AddFolderResult> {
    if (!(await this.ensurePermission())) {
      this.set({ ...idle(), phase: 'error', message: 'Oli needs permission to read your music. Allow it and try again.' })
      return { status: 'denied' }
    }
    const { plugin, store } = this.opts
    let picked: Awaited<ReturnType<OliMediaPlugin['pickFolder']>>
    try {
      picked = await plugin.pickFolder()
    } catch (err) {
      const message = String((err as Error)?.message ?? err)
      this.set({ ...idle(), phase: 'error', message })
      return { status: 'error', message }
    }
    if (picked.cancelled || !picked.volume) return { status: 'cancelled' }
    const scope: PhoneScope = { volume: picked.volume, path: picked.path ?? '' }
    const label = picked.label || scope.path || scope.volume
    const locations = store.locations()
    const all = locations.some((l) => l.id === PHONE_LIBRARY_ID)
    if (all && !replaceAll) return { status: 'needs-replace' }
    const folders = locations.filter((l) => l.id !== PHONE_LIBRARY_ID)
    const covering = folders.find((l) => {
      const other = scopeOfLocation(l.id)
      return other !== null && scopeContains(other, scope)
    })
    if (covering) {
      this.set({ ...idle(), phase: 'finished', message: `Already included in "${covering.path}"` })
      return { status: 'included', label: covering.path }
    }
    const absorbed = folders.filter((l) => {
      const other = scopeOfLocation(l.id)
      return other !== null && scopeContains(scope, other)
    })
    const id = folderLocationId(scope)
    store.ensureLocation(id, label, label)
    if (all || absorbed.length > 0) {
      // songs that are in the new folder move over (keeping favorites and play counts); the rest of the old locations goes
      try {
        store.adoptSongs(await this.songIdsIn(scope), id)
      } catch {
        // the scan below adds whatever is missing
      }
      if (all) store.removeLocation(PHONE_LIBRARY_ID)
      for (const f of absorbed) store.removeLocation(f.id)
    }
    void this.scan()
    return { status: 'added', label }
  }

  /** Removes one location (default: all the phone's music) and its songs. */
  remove(id: string = PHONE_LIBRARY_ID): void {
    this.opts.store.removeLocation(id)
    this.artCache.clear()
    if (this.opts.store.locations().length === 0) void this.opts.plugin.clearArtworkCache().catch(() => undefined)
  }

  /** The ids of the songs MediaStore lists inside a folder (null = everything). */
  private async songIdsIn(scope: PhoneScope | null): Promise<string[]> {
    const ids: string[] = []
    for (let offset = 0; ; offset += PAGE) {
      const page = await this.opts.plugin.queryAudio({ offset, limit: PAGE, ...(scope ? { volume: scope.volume, path: scope.path } : {}) })
      for (const r of page.rows) ids.push(phoneSongId(r))
      if (page.rows.length < PAGE) return ids
    }
  }

  /** A scan at most every 30 s when Android reports changes (like the desktop folder watcher). */
  onMediaChanged(): void {
    const t = Date.now()
    if (this.running || t - this.lastAutoScanAt < 30_000) return
    this.lastAutoScanAt = t
    void this.scan()
  }

  /** Reads the real format of one file (a fresh download) into its song row. */
  async describeFile(songId: string, uri: string): Promise<void> {
    try {
      const res = (await this.opts.plugin.probeFiles({ uris: [uri] })).results[0]
      if (!res) return
      this.opts.store.patchSongs([{ id: songId, patch: probeToPatch(res, {}) }])
      this.opts.store.finish(PHONE_LIBRARY_ID)
    } catch {
      // the song plays anyway; only the badge lacks details
    }
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
      const locations = store.locations()
      if (locations.length === 0) {
        this.set({ phase: 'finished', message: 'No music folders yet. Add one in Settings.' })
        return
      }
      // 1-3. for every location: list what MediaStore has, add new / changed songs, mark vanished ones missing
      const totals = { found: 0, processed: 0, added: 0, updated: 0, removed: 0 }
      for (const loc of locations) {
        if (this.canceled) return this.finishCanceled()
        if (!(await this.syncLocation(loc.id, scopeOfLocation(loc.id), totals))) return this.finishCanceled()
      }
      this.set({ filesProcessed: totals.processed, filesAdded: totals.added, filesUpdated: totals.updated, filesRemoved: totals.removed })
      store.finish(locations[0].id) // the songs are visible now; details follow in the background

      // 4. read the real format / tags of songs whose details were never read
      const unread = locations.flatMap((l) => store.songsOf(l.id)).filter((r) => !r.missing && r.sampleRate === null)
      // Lossy files (MP3, AAC, Opus, Vorbis) have nothing a file read would add (Android already lists their length and
      // bit rate): they are marked as read at once, which keeps a big mixed library fast.
      const lossy = new Set(['mp3', 'aac', 'opus', 'vorbis', 'wma', 'amr'])
      const codecs = store.codecsOf(unread.map((r) => r.id))
      const skip = unread.filter((r) => lossy.has(codecs.get(r.id) ?? ''))
      if (skip.length > 0) store.patchSongs(skip.map((r) => ({ id: r.id, patch: { sampleRate: 0 } })))
      const skipped = new Set(skip.map((r) => r.id))
      const todo = unread.filter((r) => !skipped.has(r.id))
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
        store.finish(locations[0].id)
      }
      this.set({ phase: 'finished', message: finishedMessage(totals.found, locations.length, locations.some((l) => l.id === PHONE_LIBRARY_ID)) })
    } catch (err) {
      const msg = String((err as Error)?.message ?? err)
      this.set({ phase: 'error', message: msg === 'permission' ? 'Oli needs permission to read your music.' : msg })
    }
  }

  /** Steps 1-3 for one location. Returns false when the owner canceled. */
  private async syncLocation(
    locationId: string,
    scope: PhoneScope | null,
    totals: { found: number; processed: number; added: number; updated: number; removed: number }
  ): Promise<boolean> {
    const { plugin, store } = this.opts
    const existing = new Map(store.songsOf(locationId).map((r) => [r.id, r]))

    // 1. list what MediaStore has here, page by page
    const rows: MediaRow[] = []
    for (let offset = 0; ; offset += PAGE) {
      if (this.canceled) return false
      const page = await plugin.queryAudio({ offset, limit: PAGE, ...(scope ? { volume: scope.volume, path: scope.path } : {}) })
      rows.push(...page.rows)
      this.set({ filesFound: totals.found + rows.length })
      if (page.rows.length < PAGE) break
    }
    totals.found += rows.length

    // 2. new / changed songs go into the database; unchanged ones are left alone
    this.set({ phase: 'reading', message: null })
    const seen = new Set<string>()
    let batch: Track[] = []
    const flushBatch = (): void => {
      if (batch.length === 0) return
      store.upsertTracks(batch)
      batch = []
    }
    for (const row of rows) {
      if (this.canceled) {
        flushBatch()
        return false
      }
      const t = rowToTrack(row, locationId)
      seen.add(t.id)
      const old = existing.get(t.id)
      if (!old) {
        totals.added++
        batch.push(t)
      } else if (old.modifiedAt !== t.modifiedAt || old.missing || old.path !== t.path) {
        totals.updated++
        batch.push(t)
      }
      totals.processed++
      if (batch.length >= UPSERT_BATCH) {
        flushBatch()
        this.set({ filesProcessed: totals.processed, filesAdded: totals.added, filesUpdated: totals.updated, currentFile: t.title })
        await tick()
      }
    }
    flushBatch()

    // 3. songs that vanished from here are marked missing (playlists keep them, as on the desktop)
    const gone: string[] = []
    for (const [id, r] of existing) if (!seen.has(id) && !r.missing) gone.push(id)
    if (gone.length > 0) store.markMissing(gone)
    totals.removed += gone.length
    return true
  }

  private finishCanceled(): void {
    this.opts.store.finish(this.opts.store.locations()[0]?.id ?? PHONE_LIBRARY_ID)
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

export type AddFolderResult =
  | { status: 'added'; label: string }
  | { status: 'cancelled' }
  | { status: 'denied' }
  /** The chosen folder is inside one that is already scanned. */
  | { status: 'included'; label: string }
  /** "All the phone's music" is scanned: choosing a folder replaces it (the caller asks the owner first). */
  | { status: 'needs-replace' }
  | { status: 'error'; message: string }

function finishedMessage(songs: number, locations: number, all: boolean): string {
  if (all) return `${songs} songs on this phone`
  return `${songs} songs in ${locations} ${locations === 1 ? 'folder' : 'folders'}`
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
