import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { EventEmitter } from 'node:events'
import type { Database } from './database'
import { getLogger } from './logger'
import { parseTrackFile, isAudioFile } from './metadata'
import { streamFingerprint, contentHashFile, hashString } from '../util/hash'
import { artistIdFor, albumIdFor, songIdForPath } from '../util/identity'
import type { ArtworkService } from './artwork'
import type { TranscodeService } from './transcode'
import { errorOf } from './logger'
import type { ScanProgress } from '@shared/types'
import { needsTranscodeFor } from '@shared/constants'

export interface ScanOptions {
  force?: boolean
  libraryId?: string | null
  scopeDir?: string | null
}

interface ScanCounters {
  found: number
  processed: number
  added: number
  updated: number
  removed: number
  unsupported: number
  duplicates: number
  errors: number
}

const BATCH = 50
const PARSE_CONCURRENCY = 4

const SKIP_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '$RECYCLE.BIN',
  'System Volume Information',
  '.Trash',
  '.thumbnails',
  'OneDrive',
  '.cache',
  '.trash'
])

export interface LibraryRow {
  id: string
  path: string
  name: string
}

function walk(dir: string, skipSet: Set<string>, cb: (file: string) => void): void {
  const stack: string[] = [dir]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (skipSet.has(entry.name)) continue
        stack.push(full)
      } else if (entry.isFile() && isAudioFile(entry.name)) {
        cb(full)
      }
    }
  }
}

export class LibraryScanner extends EventEmitter {
  private canceled = false

  constructor(
    private db: Database,
    private artwork: ArtworkService,
    private transcode: TranscodeService
  ) {
    super()
  }

  cancel(): void {
    this.canceled = true
  }

  reset(): void {
    this.canceled = false
  }

  private emitProgress(p: Partial<ScanProgress> & { phase: ScanProgress['phase'] }): void {
    this.emit('progress', p as ScanProgress)
  }

  /**
   * Full (or scoped) reconciliation scan of a library location.
   * Non-blocking: yields between chunks so IPC stays responsive.
   */
  async scanLibrary(options: ScanOptions = {}): Promise<ScanCounters> {
    const log = getLogger()
    const counters: ScanCounters = {
      found: 0,
      processed: 0,
      added: 0,
      updated: 0,
      removed: 0,
      unsupported: 0,
      duplicates: 0,
      errors: 0
    }
    this.reset()
    this.db.suspendPersistence()
    try {
      return await this.runScan(options, counters, log)
    } finally {
      this.db.resumePersistence()
    }
  }

  private async runScan(options: ScanOptions, counters: ScanCounters, log: ReturnType<typeof getLogger>): Promise<ScanCounters> {
    let libraries: LibraryRow[]
    if (options.libraryId) {
      libraries = this.db.all<LibraryRow>(
        'SELECT id, path, name FROM library_locations WHERE id = ?',
        [options.libraryId]
      )
    } else {
      libraries = this.db.all<LibraryRow>('SELECT id, path, name FROM library_locations')
    }
    if (libraries.length === 0) {
      this.emitProgress({ phase: 'finished', message: 'No library folders configured' })
      return counters
    }

    this.emitProgress({ phase: 'discovering', message: 'Discovering music files…' })
    const files: string[] = []
    for (const lib of libraries) {
      if (options.scopeDir) {
        if (isPathInside(options.scopeDir, lib.path)) files.push(...collectFiles(options.scopeDir))
      } else {
        walk(lib.path, SKIP_DIRS, (f) => files.push(f))
      }
    }
    const unique = [...new Set(files.map((f) => path.resolve(f)))]
    counters.found = unique.length
    log.info(`Discovered ${unique.length} audio files`)

    const seen = new Set<string>()
    const insertedNow = new Map<string, { hash: string; id: string }>()

    const albumMerge = new Map(
      this.db
        .all<{ alias: string; canonical_id: string }>(
          'SELECT alias, canonical_id FROM merged_albums'
        )
        .map((r) => [r.alias, r.canonical_id])
    )
    const artistMerge = new Map(
      this.db
        .all<{ alias: string; canonical_id: string }>(
          'SELECT alias, canonical_id FROM merged_artists'
        )
        .map((r) => [r.alias, r.canonical_id])
    )

    const parseQueue = [...unique]
    const existing = new Map(
      this.db
        .all<{ path: string; modified_at: number; file_size: number; has_embedded_artwork: number }>(
          'SELECT path, modified_at, file_size, has_embedded_artwork FROM songs'
        )
        .map((r) => [path.resolve(r.path), r])
    )

    this.emitProgress({ phase: 'reading', filesFound: counters.found })

    let batch: Array<{ type: 'insert' | 'update'; values: unknown[]; where?: unknown[] }> = []

    const flushBatch = (): void => {
      if (batch.length === 0) return
      const tx = this.db.transaction()
      try {
        for (const op of batch) {
          if (op.type === 'insert') {
            this.db.run(
              `INSERT OR REPLACE INTO songs (
                id, library_id, folder_id, title, artist, artist_id, album_artist, album, album_id,
                genre, composer, year, release_date, track_no, disc_no, isrc, rating, duration,
                bitrate, sample_rate, bit_depth, channels, codec, format, file_size, path,
                content_hash, fast_hash, replay_gain, replay_gain_album, lyrics, has_embedded_artwork,
                added_at, modified_at, play_count, missing, error, source
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              op.values
            )
          } else {
            this.db.run(
              `UPDATE songs SET title=?, artist=?, artist_id=?, album_artist=?, album=?, album_id=?,
               genre=?, composer=?, year=?, release_date=?, track_no=?, disc_no=?, isrc=?, rating=?,
               duration=?, bitrate=?, sample_rate=?, bit_depth=?, channels=?, codec=?, format=?,
               file_size=?, content_hash=?, fast_hash=?, replay_gain=?, replay_gain_album=?,
               lyrics=?, has_embedded_artwork=?, modified_at=?, missing=0, error=NULL
               WHERE id = ?`,
              [...op.values, ...(op.where ?? [])]
            )
          }
        }
        tx.commit()
      } catch (err) {
        tx.rollback()
        log.error(`Batch insert failed: ${errorOf(err)}`)
      }
      batch = []
    }

    const workers: Promise<void>[] = []
    let cursor = 0
    const take = (): string | null => {
      if (this.canceled || cursor >= parseQueue.length) return null
      return parseQueue[cursor++]
    }

    const work = async (): Promise<void> => {
      while (true) {
        const file = take()
        if (!file) return
        counters.processed++
        try {
          const resolved = path.resolve(file)
          seen.add(resolved)
          const existingRow = existing.get(resolved)
          let stat: fs.Stats
          try {
            stat = fs.statSync(file)
          } catch {
            continue
          }
          if (
            !options.force &&
            existingRow &&
            existingRow.file_size === stat.size &&
            existingRow.modified_at === Math.floor(stat.mtimeMs) &&
            !this.artwork.needsExtract(
              fileToSongId(file),
              existingRow.has_embedded_artwork === 1,
              stat.mtimeMs
            )
          ) {
            continue // unchanged
          }
          // Read only the first 256KB for the fingerprint (not the whole file);
          // metadata is parsed by streaming the file from disk.
          const head = readHead(file)
          if (!head) continue
          const parsed = await parseTrackFile(file)
          if (!parsed) {
            counters.errors++
            counters.unsupported++
            continue
          }
          if (parsed.duration <= 0) {
            const dur = await this.transcode.probeDuration(file)
            if (dur !== null) parsed.duration = dur
          }
          let fullHash: string | null = null
          if (stat.size <= 64 * 1024 * 1024) {
            const whole = await fsp.readFile(file).catch(() => null)
            if (whole) fullHash = contentHashFile(whole)
          }
          const fp = streamFingerprint(stat.size, Math.floor(stat.mtimeMs), head)

          const library = libraries.find((l) => isPathInside(file, l.path))
          const libId = library?.id ?? null
          const folderId = `dir:${hashString(path.dirname(file))}`
          const rawArtistId = artistIdFor(parsed.artist)
          const rawAlbumId = albumIdFor(parsed.albumArtist, parsed.album)
          const artistId = artistMerge.get(rawArtistId) ?? rawArtistId
          const albumId = albumMerge.get(rawAlbumId) ?? rawAlbumId
          const title = parsed.title
          const isNew = !existingRow
          if (isNew) {
            counters.added++
            insertedNow.set(fp, { hash: fullHash ?? fp, id: fileToSongId(file) })
          } else {
            counters.updated++
          }

          if (parsed.artwork) {
            const key = fileToSongId(file)
            if (this.artwork.needsExtract(key, true, stat.mtimeMs)) {
              this.artwork.store(key, parsed.artwork.data)
            }
          }

          batch.push({
            type: isNew ? 'insert' : 'update',
            values: isNew
              ? [
                  fileToSongId(file),
                  libId,
                  folderId,
                  title,
                  parsed.artist,
                  artistId,
                  parsed.albumArtist,
                  parsed.album,
                  albumId,
                  parsed.genre,
                  parsed.composer,
                  parsed.year,
                  parsed.releaseDate,
                  parsed.trackNo,
                  parsed.discNo,
                  parsed.isrc,
                  parsed.rating,
                  parsed.duration,
                  parsed.bitrate,
                  parsed.sampleRate,
                  parsed.bitDepth,
                  parsed.channels,
                  parsed.codec,
                  parsed.format,
                  stat.size,
                  file,
                  fullHash,
                  fp,
                  parsed.replayGain,
                  parsed.replayGainAlbum,
                  parsed.lyrics,
                  parsed.artwork ? 1 : 0,
                  Date.now(),
                  Math.floor(stat.mtimeMs),
                  0,
                  0,
                  null,
                  'local'
                ]
              : [
                  title,
                  parsed.artist,
                  artistId,
                  parsed.albumArtist,
                  parsed.album,
                  albumId,
                  parsed.genre,
                  parsed.composer,
                  parsed.year,
                  parsed.releaseDate,
                  parsed.trackNo,
                  parsed.discNo,
                  parsed.isrc,
                  parsed.rating,
                  parsed.duration,
                  parsed.bitrate,
                  parsed.sampleRate,
                  parsed.bitDepth,
                  parsed.channels,
                  parsed.codec,
                  parsed.format,
                  stat.size,
                  fullHash,
                  fp,
                  parsed.replayGain,
                  parsed.replayGainAlbum,
                  parsed.lyrics,
                  parsed.artwork ? 1 : 0,
                  Math.floor(stat.mtimeMs)
                ],
                where: [fileToSongId(file)]
          })
        } catch (err) {
          counters.errors++
          log.warn(`Scan failed for ${file}`, err)
        }
        if (batch.length >= BATCH) flushBatch()
        if (counters.processed % 200 === 0) {
          this.emitProgress({
            phase: 'reading',
            filesFound: counters.found,
            filesProcessed: counters.processed,
            filesAdded: counters.added,
            filesUpdated: counters.updated,
            filesRemoved: counters.removed,
            currentFile: file,
            message: `Reading ${counters.processed}/${counters.found}…`
          })
        }
        await yieldMicro()
      }
    }

    for (let i = 0; i < PARSE_CONCURRENCY; i++) workers.push(work())
    await Promise.all(workers)
    flushBatch()

    if (!this.canceled) {
      // Mark files no longer present as missing (preserves playlists & history).
      const scopeDir = options.scopeDir
      const rows = this.db.all<{ id: string; path: string }>(
        'SELECT id, path FROM songs WHERE missing = 0'
      )
      for (const row of rows) {
        if (scopeDir && !isPathInside(row.path, scopeDir)) continue
        if (seen.has(path.resolve(row.path))) continue
        this.db.run('UPDATE songs SET missing = 1 WHERE id = ?', [row.id])
        counters.removed++
      }

      // Warm the transcode cache + fix missing durations for ALL library files
      // (including unchanged ones the scan skipped) in the background: one
      // ffmpeg at a time, low priority, so those songs play instantly later.
      this.warmExistingFiles()
    }

    this.emitProgress({
      phase: this.canceled ? 'finished' : 'indexing',
      filesFound: counters.found,
      filesProcessed: counters.processed,
      filesAdded: counters.added,
      filesUpdated: counters.updated,
      filesRemoved: counters.removed,
      message: this.canceled ? 'Scan canceled' : 'Rebuilding aggregates…'
    })

    if (this.canceled) return counters

    // Move/rename detection: transfer play state between rows sharing a fingerprint.
    this.transferPlayState(insertedNow)

    this.emitProgress({
      phase: 'finished',
      filesFound: counters.found,
      filesProcessed: counters.processed,
      filesAdded: counters.added,
      filesUpdated: counters.updated,
      filesRemoved: counters.removed,
      skippedUnsupported: counters.unsupported,
      skippedDuplicates: counters.duplicates,
      itemsWithErrors: counters.errors,
      message: `Scan complete: ${counters.added} added, ${counters.updated} updated, ${counters.removed} removed`
    })
    return counters
  }

  /** Background warm-up: pre-transcode unplayable files and fix 0 durations. */
  private warmExistingFiles(): void {
    const rows = this.db.all<{ id: string; path: string; codec: string | null; duration: number }>(
      'SELECT id, path, codec, duration FROM songs WHERE missing = 0'
    )
    const toWarm: string[] = []
    const toProbe: Array<{ id: string; path: string }> = []
    for (const row of rows) {
      if (needsTranscodeFor(row.codec, row.path)) toWarm.push(row.path)
      if (!row.duration || row.duration <= 0) toProbe.push({ id: row.id, path: row.path })
    }
    if (toWarm.length === 0 && toProbe.length === 0) return
    setTimeout(() => {
      for (const file of toWarm) this.transcode.preTranscode(file)
      for (const p of toProbe) {
        void this.transcode.probeDuration(p.path).then((d) => {
          if (d && this.db.ready) {
            this.db.run('UPDATE songs SET duration = ? WHERE id = ?', [d, p.id])
          }
        })
      }
    }, 3000)
  }

  private transferPlayState(inserted: Map<string, { hash: string; id: string }>): void {
    const movedCandidates = this.db.all<{ id: string; fast_hash: string }>(
      'SELECT id, fast_hash FROM songs WHERE missing = 1 AND fast_hash IS NOT NULL'
    )
    for (const old of movedCandidates) {
      const replacement = inserted.get(old.fast_hash)
      if (!replacement) continue
      const source = this.db.get<{
        play_count: number
        last_played_at: number
        favorite: number
        rating: number
      }>('SELECT play_count, last_played_at, favorite, rating FROM songs WHERE id = ?', [old.id])
      if (!source) continue
      this.db.run(
        `UPDATE songs SET play_count = ?, last_played_at = ?, favorite = ?, rating = ? WHERE id = ?`,
        [source.play_count, source.last_played_at, source.favorite, source.rating, replacement.id]
      )
      this.db.run('DELETE FROM songs WHERE id = ?', [old.id])
    }
  }
}

function collectFiles(dir: string): string[] {
  const out: string[] = []
  walk(dir, SKIP_DIRS, (f) => out.push(f))
  return out
}

function isPathInside(file: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(file))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Reads the first 256KB of a file (used for fast fingerprints). */
function readHead(file: string): Buffer | null {
  try {
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(256 * 1024)
    try {
      const n = fs.readSync(fd, buf, 0, buf.length, 0)
      return n > 0 ? buf.subarray(0, n) : null
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

function fileToSongId(file: string): string {
  return songIdForPath(file)
}

function yieldMicro(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}