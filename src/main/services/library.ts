import * as fs from 'node:fs'
import * as path from 'node:path'
import { EventEmitter } from 'node:events'
import type { Database } from './database'
import { getLogger } from './logger'
import { LibraryScanner } from './scanner'
import { FolderWatcher } from './watcher'
import { toTrack, toAlbum, toArtist, toGenre, toLibraryFolder } from './mappers'
import { randomId } from '../util/hash'
import type { ArtworkService } from './artwork'
import type { TranscodeService } from './transcode'
import type {
  Album,
  Artist,
  ComposerInfo,
  Genre,
  LibraryFolder,
  ScanProgress,
  Track
} from '@shared/types'

export interface SongsQuery {
  search?: string | null
  artistId?: string | null
  albumId?: string | null
  genre?: string | null
  year?: number | null
  format?: string | null
  folderId?: string | null
  favoritesOnly?: boolean
  missingOnly?: boolean
  neverPlayed?: boolean
  recentlyAdded?: boolean
  recentlyPlayed?: boolean
  duplicatesOnly?: boolean
  letter?: string | null
  sort?: string
  direction?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

const SORT_COLUMNS: Record<string, string> = {
  title: 'title',
  artist: 'artist',
  album: 'album',
  albumArtist: 'album_artist',
  genre: 'genre',
  duration: 'duration',
  trackNo: 'track_no',
  discNo: 'disc_no',
  bitrate: 'bitrate',
  format: 'format',
  year: 'year',
  addedAt: 'added_at',
  modifiedAt: 'modified_at',
  lastPlayed: 'last_played_at',
  playCount: 'play_count',
  rating: 'rating',
  fileSize: 'file_size',
  random: 'RANDOM()'
}

const VALID_SORTS = new Set(Object.keys(SORT_COLUMNS))

export class LibraryService extends EventEmitter {
  scanner: LibraryScanner
  watcher = new FolderWatcher()
  private activeScan: Promise<unknown> | null = null

  constructor(
    private db: Database,
    private artwork: ArtworkService,
    transcode: TranscodeService
  ) {
    super()
    this.scanner = new LibraryScanner(db, artwork, transcode)
    this.scanner.on('progress', (p: ScanProgress) => {
      this._lastProgress = p
      this.emit('scan-progress', p)
    })
    this.watcher.on('changed', ({ root, file }) => {
      void this.handleWatchEvent(root, file)
    })
    this.watcher.on('sweep', ({ root }) => {
      void this.handleWatchEvent(root, null)
    })
  }

  // ------------------------------------------------------------------
  // Folders
  // ------------------------------------------------------------------

  async addFolder(dir: string): Promise<LibraryFolder | null> {
    const resolved = path.resolve(dir)
    let stat: fs.Stats
    try {
      stat = fs.statSync(resolved)
      if (!stat.isDirectory()) throw new Error('Not a directory')
    } catch (err) {
      getLogger().warn(`addFolder invalid: ${resolved}`, err)
      return null
    }
    const existing = this.db.get<{ id: string }>(
      'SELECT id FROM library_locations WHERE path = ?',
      [resolved]
    )
    if (existing) {
      return this.getFolder(existing.id)
    }
    const id = randomId()
    this.db.run(
      'INSERT INTO library_locations (id, path, name, added_at) VALUES (?, ?, ?, ?)',
      [id, resolved, path.basename(resolved), Date.now()]
    )
    this.emit('library-changed')
    void this.scanLibrary(id)
    return this.getFolder(id)
  }

  getFolder(id: string): LibraryFolder | null {
    const row = this.db.get<Record<string, unknown>>(
      `SELECT ll.*,
        (SELECT COUNT(*) FROM songs s WHERE s.library_id = ll.id AND s.missing = 0) AS trackCount,
        (SELECT COALESCE(SUM(file_size), 0) FROM songs s WHERE s.library_id = ll.id) AS totalSize
       FROM library_locations ll WHERE ll.id = ?`,
      [id]
    )
    return row ? toLibraryFolder(row) : null
  }

  getFolders(): LibraryFolder[] {
    return this.db
      .all<Record<string, unknown>>(
        `SELECT ll.*,
          (SELECT COUNT(*) FROM songs s WHERE s.library_id = ll.id AND s.missing = 0) AS trackCount,
          (SELECT COALESCE(SUM(file_size), 0) FROM songs s WHERE s.library_id = ll.id) AS totalSize
         FROM library_locations ll ORDER BY ll.added_at ASC`
      )
      .map(toLibraryFolder)
  }

  /**
   * Removing a library location deletes ONLY songs that belong to it.
   * Playlists keep their entries; the UI renders them as missing tracks.
   */
  removeFolder(id: string): void {
    this.watcher.stopWatching(
      this.db.get<{ path: string }>('SELECT path FROM library_locations WHERE id = ?', [id])
        ?.path ?? ''
    )
    this.db.run('DELETE FROM library_locations WHERE id = ?', [id])
    this.db.run('DELETE FROM songs WHERE library_id = ?', [id])
    this.rebuildAggregates()
    this.emit('library-changed')
  }

  // ------------------------------------------------------------------
  // Scanning
  // ------------------------------------------------------------------

  async scanLibrary(libraryId?: string, force = false): Promise<void> {
    if (this.activeScan) return this.activeScan as Promise<void>
    const promise = (async () => {
      const counters = await this.scanner.scanLibrary({ libraryId, force })
      getLogger().info('Scan finished', counters)
      this.rebuildAggregates()
      if (libraryId) {
        this.db.run('UPDATE library_locations SET last_scan_at = ? WHERE id = ?', [
          Date.now(),
          libraryId
        ])
      }
      if (this.watcher.disabled) this.startWatchers()
      this.emit('scan-complete', counters)
      this.emit('library-changed')
    })()
    this.activeScan = promise
    try {
      await promise
    } finally {
      this.activeScan = null
    }
  }

  cancelScan(): void {
    this.scanner.cancel()
  }

  get lastProgress(): ScanProgress | null {
    return this._lastProgress
  }

  private _lastProgress: ScanProgress | null = null

  /** When the last watch-event-triggered scan ran (rate-limits A:\ noise). */
  private lastWatchScanAt = 0

  startWatchers(): void {
    for (const folder of this.getFolders()) {
      if (fs.existsSync(folder.path)) this.watcher.watchRoot(folder.path)
    }
  }

  stopWatchers(): void {
    this.watcher.clear()
  }

  private async handleWatchEvent(root: string, _file: string | null): Promise<void> {
    try {
      const lib = this.db.get<{ id: string }>(
        'SELECT id FROM library_locations WHERE path = ?',
        [path.resolve(root)]
      )
      if (!lib) return
      if (this.activeScan) return // full scan will reconcile everything
      // Rate-limit: watch events (e.g. from the drive's own metadata traffic)
      // must not trigger a full rescan every few seconds.
      if (Date.now() - this.lastWatchScanAt < 30_000) return
      this.lastWatchScanAt = Date.now()
      await this.scanLibrary(lib.id, false)
    } catch (err) {
      getLogger().warn('Watch event scan failed', err)
    }
  }

  // ------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------

  buildSongsQuery(q: SongsQuery): {
    sql: string
    countSql: string
    params: unknown[]
    countParams: unknown[]
  } {
    const where: string[] = [q.missingOnly ? 's.missing = 1' : 's.missing = 0']
    const params: unknown[] = []
    const push = (clause: string, value: unknown): void => {
      where.push(clause)
      params.push(value)
    }
    if (q.search) {
      const like = `%${q.search.toLowerCase()}%`
      where.push(
        `(LOWER(s.title) LIKE ? OR LOWER(s.artist) LIKE ? OR LOWER(s.album) LIKE ? OR LOWER(s.genre) LIKE ? OR LOWER(s.path) LIKE ? OR LOWER(s.composer) LIKE ?)`
      )
      for (let i = 0; i < 6; i++) params.push(like)
    }
    if (q.artistId) push('s.artist_id = ?', q.artistId)
    if (q.albumId) push('s.album_id = ?', q.albumId)
    if (q.genre) push('LOWER(s.genre) = ?', q.genre.toLowerCase())
    if (q.year) push('s.year = ?', q.year)
    if (q.format) push('LOWER(s.format) = ?', q.format.toLowerCase())
    if (q.folderId) push('s.folder_id = ?', q.folderId)
    if (q.favoritesOnly) where.push('s.favorite = 1')
    if (q.neverPlayed) push('s.play_count = 0', 0)
    if (q.recentlyAdded) push('s.added_at >= ?', Date.now() - 30 * 86400_000)
    if (q.recentlyPlayed)
      push('s.last_played_at IS NOT NULL AND s.last_played_at >= ?', Date.now() - 30 * 86400_000)
    if (q.letter) {
      if (q.letter === '#') {
        where.push(`(s.title COLLATE NOCASE < 'a' OR s.title GLOB '[^a-zA-Z]*')`)
      } else {
        where.push(`s.title COLLATE NOCASE LIKE ?`, `${q.letter}%`)
      }
    }
    if (q.duplicatesOnly) {
      where.push(
        `s.content_hash IN (SELECT content_hash FROM songs WHERE content_hash IS NOT NULL GROUP BY content_hash HAVING COUNT(*) > 1)`
      )
    }
    const sortCol = q.sort && VALID_SORTS.has(q.sort) ? SORT_COLUMNS[q.sort] : 'title'
    const direction = q.direction === 'desc' ? 'DESC' : 'ASC'
    let orderBy =
      q.sort === 'random' ? 'RANDOM()' : `${sortCol} COLLATE NOCASE ${direction}, s.title COLLATE NOCASE ASC`
    // When searching, rank "title starts with the query" above everything
    // else; remaining matches (substring in title, artist, album, ...) follow.
    let searchPrefix: unknown = null
    if (q.search) {
      const prefix = `${q.search.toLowerCase().replace(/[%_]/g, '')}%`
      searchPrefix = prefix
      params.push(prefix)
      orderBy = `(CASE WHEN LOWER(s.title) LIKE ? THEN 0 ELSE 1 END) ASC, ${orderBy}`
    }
    const base = `FROM songs s WHERE ${where.join(' AND ')}`
    const limitSql = q.limit != null ? ` LIMIT ${Math.max(0, q.limit)}` : ''
    const offsetSql = q.offset ? ` OFFSET ${Math.max(0, q.offset)}` : ''
    // The count query has no ORDER BY, so it must not receive the prefix param.
    const countParams = searchPrefix !== null ? params.slice(0, -1) : params
    return {
      sql: `SELECT s.* ${base} ORDER BY ${orderBy}${limitSql}${offsetSql}`,
      countSql: `SELECT COUNT(*) AS n ${base}`,
      params,
      countParams
    }
  }

  querySongs(q: SongsQuery): { tracks: Track[]; total: number } {
    const { sql, countSql, params, countParams } = this.buildSongsQuery(q)
    const tracks = this.db.all<Record<string, unknown>>(sql, params).map(toTrack)
    const total = Number(this.db.get<{ n: number }>(countSql, countParams)?.n ?? 0)
    return { tracks, total }
  }

  getSongById(id: string): Track | null {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM songs WHERE id = ?', [id])
    return row ? toTrack(row) : null
  }

  getSongByPath(filePath: string): Track | null {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM songs WHERE path = ?', [
      path.resolve(filePath)
    ])
    return row ? toTrack(row) : null
  }

  getSongsByIds(ids: string[]): Track[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(',')
    return this.db
      .all<Record<string, unknown>>(`SELECT * FROM songs WHERE id IN (${placeholders})`, ids)
      .map(toTrack)
  }

  getAlbums(): Album[] {
    return this.db
      .all<Record<string, unknown>>(
        `SELECT a.*, COALESCE((SELECT s.has_embedded_artwork FROM songs s WHERE s.id = a.track_id), 0) AS has_embedded_artwork
         FROM albums a ORDER BY a.title COLLATE NOCASE ASC`
      )
      .map(toAlbum)
  }

  getAlbumById(id: string): Album | null {
    const row = this.db.get<Record<string, unknown>>(
      `SELECT a.*, COALESCE((SELECT s.has_embedded_artwork FROM songs s WHERE s.id = a.track_id), 0) AS has_embedded_artwork
       FROM albums a WHERE a.id = ?`,
      [id]
    )
    return row ? toAlbum(row) : null
  }

  getAlbumSongs(albumId: string): Track[] {
    return this.db
      .all<Record<string, unknown>>(
        'SELECT * FROM songs WHERE album_id = ? AND missing = 0 ORDER BY disc_no, track_no, title COLLATE NOCASE',
        [albumId]
      )
      .map(toTrack)
  }

  getArtists(): Artist[] {
    return this.db
      .all<Record<string, unknown>>(
        'SELECT * FROM artists ORDER BY sort_name COLLATE NOCASE ASC, name COLLATE NOCASE ASC'
      )
      .map(toArtist)
  }

  getArtistById(id: string): Artist | null {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM artists WHERE id = ?', [id])
    return row ? toArtist(row) : null
  }

  getArtistAlbums(artistId: string): Album[] {
    return this.db
      .all<Record<string, unknown>>(
        `SELECT a.*, COALESCE((SELECT s.has_embedded_artwork FROM songs s WHERE s.id = a.track_id), 0) AS has_embedded_artwork
         FROM albums a
         JOIN songs s ON s.album_id = a.id
         WHERE s.artist_id = ? AND s.missing = 0
         GROUP BY a.id ORDER BY a.year DESC, a.title COLLATE NOCASE ASC`,
        [artistId]
      )
      .map(toAlbum)
  }

  getArtistSongs(artistId: string): Track[] {
    return this.db
      .all<Record<string, unknown>>(
        'SELECT * FROM songs WHERE artist_id = ? AND missing = 0 ORDER BY album COLLATE NOCASE, track_no',
        [artistId]
      )
      .map(toTrack)
  }

  getGenres(): Genre[] {
    return this.db
      .all<Record<string, unknown>>(
        'SELECT * FROM genres WHERE track_count > 0 ORDER BY name COLLATE NOCASE ASC'
      )
      .map(toGenre)
  }

  getGenreSongs(genre: string): Track[] {
    return this.db
      .all<Record<string, unknown>>(
        'SELECT * FROM songs WHERE LOWER(genre) = ? AND missing = 0 ORDER BY title COLLATE NOCASE',
        [genre.toLowerCase()]
      )
      .map(toTrack)
  }

  getComposers(): ComposerInfo[] {
    return this.db
      .all<Record<string, unknown>>(
        `SELECT composer AS name, COUNT(*) AS track_count, COUNT(DISTINCT album_id) AS album_count
         FROM songs
         WHERE composer IS NOT NULL AND composer != '' AND missing = 0
         GROUP BY composer COLLATE NOCASE
         ORDER BY composer COLLATE NOCASE ASC`
      )
      .map((r) => ({
        name: String(r.name),
        trackCount: Number(r.track_count ?? 0),
        albumCount: Number(r.album_count ?? 0)
      }))
  }

  getComposerSongs(composer: string): Track[] {
    return this.db
      .all<Record<string, unknown>>(
        'SELECT * FROM songs WHERE LOWER(composer) = ? AND missing = 0 ORDER BY title COLLATE NOCASE',
        [composer.toLowerCase()]
      )
      .map(toTrack)
  }

  getFolderArtworks(folderId: string): string | null {
    const row = this.db.get<{ path: string }>('SELECT path FROM songs WHERE folder_id = ? LIMIT 1', [
      folderId
    ])
    return row ? path.dirname(row.path) : null
  }

  getStats(): {
    folderCount: number
    trackCount: number
    albumCount: number
    artistCount: number
    playlistCount: number
    favoriteCount: number
    missingCount: number
    totalDuration: number
    totalSize: number
  } {
    const stats = this.db.get<{
      trackCount: number
      totalDuration: number
      totalSize: number
      missingCount: number
      favoriteCount: number
    }>(
      `SELECT
        COUNT(*) AS trackCount,
        COALESCE(SUM(duration), 0) AS totalDuration,
        COALESCE(SUM(file_size), 0) AS totalSize,
        SUM(CASE WHEN missing = 1 THEN 1 ELSE 0 END) AS missingCount,
        SUM(CASE WHEN favorite = 1 THEN 1 ELSE 0 END) AS favoriteCount
       FROM songs
       WHERE missing = 0`
    ) ?? { trackCount: 0, totalDuration: 0, totalSize: 0, missingCount: 0, favoriteCount: 0 }
    return {
      folderCount: this.db.count('SELECT id FROM library_locations'),
      trackCount: Number(stats.trackCount ?? 0),
      albumCount: this.db.count('SELECT id FROM albums WHERE track_count > 0'),
      artistCount: this.db.count('SELECT id FROM artists WHERE track_count > 0'),
      playlistCount: this.db.count('SELECT id FROM playlists'),
      favoriteCount: Number(stats.favoriteCount ?? 0),
      missingCount: Number(stats.missingCount ?? 0),
      totalDuration: Number(stats.totalDuration ?? 0),
      totalSize: Number(stats.totalSize ?? 0)
    }
  }

  /**
   * Merge several albums into one canonical album. All songs tagged with the
   * alias album ids are reassigned to `canonicalId`, and the alias is recorded
   * in `merged_albums` so future scans keep the merge.
   */
  mergeAlbums(canonicalId: string, aliasIds: string[]): number {
    const aliases = [...new Set(aliasIds.filter((id) => id && id !== canonicalId))]
    if (aliases.length === 0) return 0
    const canonical = this.db.get<{ title: string; artist: string }>(
      'SELECT title, artist FROM albums WHERE id = ?',
      [canonicalId]
    )
    if (!canonical) return 0
    const tx = this.db.transaction()
    try {
      for (const alias of aliases) {
        this.db.run(
          `INSERT OR IGNORE INTO merged_albums (id, canonical_id, alias, created_at) VALUES (?, ?, ?, ?)`,
          [randomId(), canonicalId, alias, Date.now()]
        )
        this.db.run(
          'UPDATE songs SET album_id = ?, album = ?, album_artist = ? WHERE album_id = ?',
          [canonicalId, canonical.title, canonical.artist, alias]
        )
      }
      this.moveFavorites('album', canonicalId, aliases)
      tx.commit()
    } catch (err) {
      tx.rollback()
      throw err
    }
    this.rebuildAggregates()
    this.emit('library-changed')
    return aliases.length
  }

  /**
   * Merge several artists into one canonical artist. All songs tagged with the
   * alias artist ids are reassigned to `canonicalId`, and the alias is recorded
   * in `merged_artists` so future scans keep the merge.
   */
  mergeArtists(canonicalId: string, aliasIds: string[]): number {
    const aliases = [...new Set(aliasIds.filter((id) => id && id !== canonicalId))]
    if (aliases.length === 0) return 0
    const canonical = this.db.get<{ name: string }>('SELECT name FROM artists WHERE id = ?', [
      canonicalId
    ])
    if (!canonical) return 0
    const tx = this.db.transaction()
    try {
      for (const alias of aliases) {
        this.db.run(
          `INSERT OR IGNORE INTO merged_artists (id, canonical_id, alias, created_at) VALUES (?, ?, ?, ?)`,
          [randomId(), canonicalId, alias, Date.now()]
        )
        this.db.run('UPDATE songs SET artist_id = ?, artist = ? WHERE artist_id = ?', [
          canonicalId,
          canonical.name,
          alias
        ])
      }
      this.moveFavorites('artist', canonicalId, aliases)
      tx.commit()
    } catch (err) {
      tx.rollback()
      throw err
    }
    this.rebuildAggregates()
    this.emit('library-changed')
    return aliases.length
  }

  private moveFavorites(itemType: 'album' | 'artist', canonicalId: string, aliasIds: string[]): void {
    if (aliasIds.length === 0) return
    const placeholders = aliasIds.map(() => '?').join(',')
    const rows = this.db.all<{ item_id: string }>(
      `SELECT item_id FROM favorites WHERE item_type = ? AND item_id IN (${placeholders})`,
      [itemType, ...aliasIds]
    )
    if (rows.length === 0) return
    this.db.run(
      `DELETE FROM favorites WHERE item_type = ? AND item_id IN (${placeholders})`,
      [itemType, ...aliasIds]
    )
    if (!this.db.get('SELECT id FROM favorites WHERE item_type = ? AND item_id = ?', [itemType, canonicalId])) {
      this.db.run('INSERT INTO favorites (id, item_type, item_id, created_at) VALUES (?, ?, ?, ?)', [
        randomId(),
        itemType,
        canonicalId,
        Date.now()
      ])
    }
    if (itemType === 'album') {
      this.db.run('UPDATE albums SET favorite = 1 WHERE id = ?', [canonicalId])
    } else {
      this.db.run('UPDATE artists SET favorite = 1 WHERE id = ?', [canonicalId])
    }
  }

    // ------------------------------------------------------------------
  // Aggregates
  // ------------------------------------------------------------------

  rebuildAggregates(): void {
    const log = getLogger()
    const tx = this.db.transaction()
    try {
      // Albums
      this.db.run('DELETE FROM albums')
      this.db.run(`INSERT INTO albums (id, title, artist, year, genre, track_id, track_count, total_duration, favorite, added_at)
        SELECT
          s.album_id,
          MAX(s.album),
          CASE
            WHEN MAX(s.album_artist) <> '' THEN MAX(s.album_artist)
            WHEN COUNT(DISTINCT s.artist_id) > 1 THEN 'Various Artists'
            ELSE MAX(s.artist)
          END,
          MIN(s.year),
          MAX(s.genre),
          MAX(s.id),
          COUNT(*),
          SUM(s.duration),
          0,
          MIN(s.added_at)
        FROM songs s
        WHERE s.album_id IS NOT NULL AND s.missing = 0
        GROUP BY s.album_id`)
      // Artists
      this.db.run('DELETE FROM artists')
      this.db.run(`INSERT INTO artists (id, name, sort_name, genre, favorite, track_count, album_count, added_at)
        SELECT
          s.artist_id,
          MAX(s.artist),
          MAX(s.artist),
          MAX(s.genre),
          0,
          COUNT(*),
          COUNT(DISTINCT s.album_id),
          MIN(s.added_at)
        FROM songs s
        WHERE s.artist_id IS NOT NULL AND s.missing = 0
        GROUP BY s.artist_id`)
      // Genres
      this.db.run('DELETE FROM genres')
      this.db.run(`INSERT INTO genres (id, name, track_count)
        SELECT 'genre:' || LOWER(REPLACE(TRIM(s.genre), ' ', '-')),
               TRIM(s.genre),
               COUNT(*)
        FROM songs s
        WHERE s.genre IS NOT NULL AND LENGTH(TRIM(s.genre)) > 0 AND s.missing = 0
        GROUP BY TRIM(s.genre)`)
      tx.commit()
    } catch (err) {
      tx.rollback()
      log.error('rebuildAggregates failed', err)
    }
  }

  /** Broadcast a library change to listeners (and the renderer) without a rescan. */
  notifyChanged(): void {
    this.emit('library-changed')
  }

  get artworkArtworkDir(): string {
    return this.artwork.cacheDir
  }

  getSongsForFolderId(folderId: string): Track[] {
    return this.db
      .all<Record<string, unknown>>(
        'SELECT * FROM songs WHERE folder_id = ? AND missing = 0 ORDER BY title',
        [folderId]
      )
      .map(toTrack)
  }
}