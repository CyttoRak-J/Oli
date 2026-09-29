/**
 * The phone app's "main process": it opens the same SQLite database schema as the desktop app (sql.js, kept in the web
 * view's IndexedDB) and creates the same services, so playlists, favorites, queue, history, search, settings and the
 * library screens behave exactly like the desktop ones. Phone-only pieces (scanning the phone's music, downloads,
 * YouTube, native audio) are added around this in webBackend.ts and in native code.
 */
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'
import { Database, type DatabasePersistence } from '@main/services/database'
import { runMigrations } from '@main/services/migrations'
import { SettingsStore } from '@main/services/settingsStore'
import { LibraryQueries } from '@main/services/libraryQueries'
import { PlaylistService } from '@main/services/playlists'
import { FavoritesService } from '@main/services/favorites'
import { HistoryService, PlaybackStateStore, QueueService } from '@main/services/playerState'
import { AnalyticsService } from '@main/services/analytics'
import { SearchService } from '@main/services/search'
import { LyricsService } from '@main/services/lyrics'
import { buildCoreHandlers, type ChannelHandler } from '@main/services/coreHandlers'
import { albumIdFor, artistIdFor, songIdForPath } from '@main/util/identity'
import { IPC } from '@shared/ipc'
import type { Track } from '@shared/types'
import type { PhoneStore } from './phoneLibrary'
import { createPhoneStore } from './phoneStore'
import { applySongEdits, type FileTagWriter, type TrackEdit } from './songEdits'

// ------------------------------------------------------------------ database storage (IndexedDB)
const IDB_NAME = 'oli'
const IDB_STORE = 'files'
const IDB_KEY = 'library.sqlite'

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = (): void => {
      req.result.createObjectStore(IDB_STORE)
    }
    req.onsuccess = (): void => resolve(req.result)
    req.onerror = (): void => reject(req.error)
  })
}

const idbPersistence: DatabasePersistence = {
  async load() {
    const db = await openIdb()
    return new Promise<Uint8Array | null>((resolve, reject) => {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(IDB_KEY)
      req.onsuccess = (): void => resolve((req.result as Uint8Array | undefined) ?? null)
      req.onerror = (): void => reject(req.error)
    })
  },
  async save(bytes) {
    const db = await openIdb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite')
      tx.objectStore(IDB_STORE).put(bytes, IDB_KEY)
      tx.oncomplete = (): void => resolve()
      tx.onerror = (): void => reject(tx.error)
    })
  }
}

// ------------------------------------------------------------------ core
export interface AndroidCore {
  db: Database
  handlers: Record<string, ChannelHandler>
  /** Add or update a song in the library database (same columns the desktop scanner fills). */
  upsertTrack(track: Track): void
  /** Called when the library changed (after adding songs). */
  onChange(listener: (channel: string, payload: unknown) => void): void
  /** Database side of the phone-music scanner (phoneLibrary.ts). */
  phone: PhoneStore
  /** Edit a song's tags (library always, file too when it is one of Oli's own downloads). */
  editSong(songId: string, edits: TrackEdit, writeFileTags?: FileTagWriter): Promise<boolean>
  /** After the library database was replaced by a backup: migrate, reload settings, refresh the screens. */
  afterRestore(): void
}

const noProviders = {
  isSpotifyConfigured: (): boolean => false,
  isYouTubeConfigured: (): boolean => false,
  searchSpotify: async (): Promise<never[]> => [],
  searchYouTube: async (): Promise<never[]> => [],
  status: (): unknown => ({ spotifyConfigured: false, youtubeConfigured: false })
}

export async function initAndroidCore(): Promise<AndroidCore> {
  const db = new Database({ file: 'library.sqlite', persistence: idbPersistence, wasmUrl })
  await db.init()
  runMigrations(db)

  const settings = new SettingsStore(db)
  settings.load()
  const library = new LibraryQueries(db)
  const playlists = new PlaylistService(db)
  const favorites = new FavoritesService(db)
  const playback = new PlaybackStateStore(db)
  const queue = new QueueService(db)
  const history = new HistoryService(db)
  const analytics = new AnalyticsService(db)
  const search = new SearchService(db, noProviders, settings)
  const lyrics = new LyricsService(db, () => settings.get('lyricsOnline') === 'enabled')

  const listeners: Array<(channel: string, payload: unknown) => void> = []
  const emit = (channel: string, payload: unknown): void => {
    for (const l of listeners) l(channel, payload)
  }
  library.on('library-changed', () => emit(IPC.onLibraryChanged, library.getStats()))

  // The database lives in memory: save it whenever the app goes to the background (Android may kill it there).
  const flush = (): void => {
    if (db.isDirty) db.flushToDisk()
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
  window.addEventListener('pagehide', flush)

  const handlers = buildCoreHandlers(
    { settings, library, playlists, favorites, playback, queue, history, analytics, search, lyrics, providers: noProviders },
    emit
  )

  function upsertTrack(t: Track): void {
    const now = Date.now()
    db.run(
      `INSERT INTO songs (id, title, artist, artist_id, album_artist, album, album_id, genre, composer, year, release_date,
         track_no, disc_no, isrc, rating, duration, bitrate, sample_rate, bit_depth, channels, codec, format, file_size, path,
         replay_gain, replay_gain_album, lyrics, has_embedded_artwork, added_at, modified_at, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local')
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, artist = excluded.artist, artist_id = excluded.artist_id, album_artist = excluded.album_artist,
         album = excluded.album, album_id = excluded.album_id, genre = excluded.genre, composer = excluded.composer,
         year = excluded.year, release_date = excluded.release_date, track_no = excluded.track_no, disc_no = excluded.disc_no,
         duration = excluded.duration, bitrate = excluded.bitrate, sample_rate = excluded.sample_rate,
         bit_depth = excluded.bit_depth, channels = excluded.channels, codec = excluded.codec, format = excluded.format,
         file_size = excluded.file_size, modified_at = excluded.modified_at, missing = 0`,
      [
        t.id, t.title, t.artist, t.artistId, t.albumArtist, t.album, t.albumId, t.genre, t.composer, t.year, t.releaseDate,
        t.trackNo, t.discNo, t.isrc, t.rating, t.duration, t.bitrate, t.sampleRate, t.bitDepth, t.channels, t.codec, t.format,
        t.fileSize, t.path, t.replayGain, t.replayGainAlbum, t.lyrics, t.hasEmbeddedArtwork ? 1 : 0, t.addedAt || now, now
      ]
    )
    library.rebuildAggregates()
    library.notifyChanged()
  }

  const phone = createPhoneStore(db, library, flush)

  const afterRestore = (): void => {
    runMigrations(db)
    settings.load()
    library.rebuildAggregates()
    emit(IPC.onLibraryChanged, library.getStats())
    flush()
  }

  return {
    db,
    handlers,
    phone,
    editSong: (songId, edits, writeFileTags) => applySongEdits(db, library, songId, edits, writeFileTags),
    afterRestore,
    upsertTrack,
    onChange: (l) => {
      listeners.push(l)
    }
  }
}

/** Ids that match the desktop app's scheme (cyrb64 of the path / names), so data can move between the apps. */
export const trackIds = { songIdForPath, artistIdFor, albumIdFor }
