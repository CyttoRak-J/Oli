import * as fs from 'node:fs'
import * as path from 'node:path'
import { getLogger } from './logger'
import type { Database } from './database'
import { FOLDER_ARTWORK_NAMES } from '@shared/constants'

/**
 * Disk-backed artwork cache.
 *
 * Embedded artwork is extracted by the scanner and stored into this cache;
 * folder artwork (`cover.jpg`, `folder.png`, ...) is locatable on demand.
 * Cache entries are tracked in the `artwork_cache` table for LRU eviction.
 */
export class ArtworkService {
  constructor(
    private db: Database,
    private _cacheDir: string
  ) {}

  get cacheDir(): string {
    return this._cacheDir
  }

  ensure(): void {
    try {
      fs.mkdirSync(this._cacheDir, { recursive: true })
    } catch (err) {
      getLogger().warn('Could not create artwork cache directory', err)
    }
  }

  private fileNameFor(key: string): string {
    return `${key.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160)}.img`
  }

  /** Store raw image bytes under a logical key; returns the cache file path. */
  store(key: string, bytes: Buffer, source: 'embedded' | 'folder' = 'embedded'): string {
    this.ensure()
    const file = path.join(this._cacheDir, this.fileNameFor(key))
    try {
      fs.writeFileSync(file, bytes)
    } catch (err) {
      getLogger().warn(`Artwork store failed for ${key}`, err)
      return ''
    }
    this.db.run(
      `INSERT INTO artwork_cache (key, media_type, source, stored_path, created_at, last_used)
       VALUES (?, 'image', ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         stored_path = excluded.stored_path,
         last_used = excluded.last_used`,
      [key, source, file, Date.now(), Date.now()]
    )
    return file
  }

  /** Resolves a cached key to an existing cache file path, or null. */
  get(key: string): string | null {
    const row = this.db.get<{ stored_path: string }>(
      'SELECT stored_path FROM artwork_cache WHERE key = ?',
      [key]
    )
    if (!row?.stored_path) return null
    if (fs.existsSync(row.stored_path)) {
      this.touch(key)
      return row.stored_path
    }
    return null
  }

  private touch(key: string): void {
    try {
      this.db.run('UPDATE artwork_cache SET last_used = ? WHERE key = ?', [Date.now(), key])
    } catch {
      // ignore
    }
  }

  /** Drop a cache entry (and its file); returns true when something was removed. */
  remove(key: string): boolean {
    const row = this.db.get<{ stored_path: string }>(
      'SELECT stored_path FROM artwork_cache WHERE key = ?',
      [key]
    )
    if (!row?.stored_path) return false
    try {
      if (fs.existsSync(row.stored_path)) fs.unlinkSync(row.stored_path)
    } catch {
      // ignore
    }
    this.db.run('DELETE FROM artwork_cache WHERE key = ?', [key])
    return true
  }

  /**
   * True when the artwork cache needs (re-)extraction for a track: no cache
   * row/file at all, or the cached image is older than the audio file (a
   * re-tagged file must refresh its cached cover). Pass `fileMtimeMs` to
   * enable the staleness check. Evicted entries are excluded (cleanup resets
   * has_embedded_artwork), so this never fights the cache budget.
   */
  needsExtract(key: string, hasEmbedded: boolean, fileMtimeMs?: number): boolean {
    if (!hasEmbedded) return false
    const row = this.db.get<{ stored_path: string }>(
      'SELECT stored_path FROM artwork_cache WHERE key = ?',
      [key]
    )
    if (!row?.stored_path) return true
    if (!fs.existsSync(row.stored_path)) return true
    if (fileMtimeMs != null) {
      try {
        if (fs.statSync(row.stored_path).mtimeMs < fileMtimeMs) return true
      } catch {
        return true
      }
    }
    return false
  }

  /**
   * Returns cached folder artwork path for a directory, discovering and caching
   * `cover.*`/`folder.*` image files on first call.
   */
  folder(dir: string): string | null {
    const key = this.folderKey(dir)
    const cached = this.get(key)
    if (cached) return cached
    const found = this.findCoverFile(dir)
    if (!found) return null
    return this.store(key, found.data, 'folder')
  }

  /**
   * Cover fallback for songs inside a merged album: when the song has no
   * artwork of its own, return the song id of a sibling in the same merged
   * album that does have a cached cover (or null when none exists). This lets
   * tracks from a cover-less album reuse the artwork of the merged one.
   */
  albumCoverSource(songId: string): string | null {
    if (!songId) return null
    const row = this.db.get<{ album_id: string | null }>(
      'SELECT album_id FROM songs WHERE id = ?',
      [songId]
    )
    if (!row?.album_id) return null
    const siblings = this.db.all<{ id: string }>(
      `SELECT s.id FROM songs s
       WHERE s.album_id = ? AND s.id != ? AND s.has_embedded_artwork = 1
       ORDER BY s.track_no IS NULL, s.track_no, s.title
       LIMIT 10`,
      [row.album_id, songId]
    )
    for (const sibling of siblings) {
      if (this.get(sibling.id)) return sibling.id
    }
    return null
  }

  /** Memory-efficient cover lookup: returns the first matching image file. */
  private findCoverFile(dir: string): { data: Buffer; name: string } | null {
    let entries: string[] = []
    try {
      entries = fs.readdirSync(dir)
    } catch {
      return null
    }
    const lower = entries.map((n) => n.toLowerCase())
    for (const wanted of FOLDER_ARTWORK_NAMES) {
      const idx = lower.indexOf(wanted)
      if (idx !== -1) {
        return this.readImage(path.join(dir, entries[idx]))
      }
    }
    // Fallback: any of the common cover extensions
    for (const entry of entries) {
      const ext = path.extname(entry).toLowerCase()
      if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
        return this.readImage(path.join(dir, entry))
      }
    }
    return null
  }

  private readImage(fullPath: string): { data: Buffer; name: string } | null {
    try {
      const data = fs.readFileSync(fullPath)
      if (data.length === 0) return null
      return { data, name: path.basename(fullPath) }
    } catch {
      return null
    }
  }

  folderKey(dir: string): string {
    return `folder:${dirKeyExpr(dir)}`
  }

  /** Evict least-recently-used entries until total size is under maxMB. */
  cleanup(maxMB: number): void {
    let files: { file: string; size: number }[] = []
    try {
      files = fs
        .readdirSync(this._cacheDir)
        .map((name) => {
          const full = path.join(this._cacheDir, name)
          let size = 0
          try {
            size = fs.statSync(full).size
          } catch {
            size = 0
          }
          return { file: full, size }
        })
    } catch {
      return
    }
    let totalBytes = files.reduce((acc, f) => acc + f.size, 0)
    const limit = Math.max(0, maxMB) * 1024 * 1024
    if (totalBytes <= limit) return
    const ordered: string[] = this.db
      .all<{ stored_path: string }>(
        'SELECT stored_path FROM artwork_cache ORDER BY last_used ASC'
      )
      .map((r) => r.stored_path)
    const seen = new Set<string>()
    for (const file of ordered) {
      if (totalBytes <= limit) break
      if (seen.has(file)) continue
      seen.add(file)
      try {
        const size = fs.statSync(file).size
        fs.unlinkSync(file)
        totalBytes -= size
        const row = this.db.get<{ key: string }>(
          'SELECT key FROM artwork_cache WHERE stored_path = ?',
          [file]
        )
        if (row) {
          this.db.run('DELETE FROM artwork_cache WHERE stored_path = ?', [file])
          if (row.key.startsWith('song:')) {
            this.db.run('UPDATE songs SET has_embedded_artwork = 0 WHERE id = ?', [row.key.slice(5)])
          }
        }
      } catch {
        // ignore
      }
    }
    // Remove stray files that are no longer referenced
    const referenced = new Set(
      this.db
        .all<{ stored_path: string }>('SELECT stored_path FROM artwork_cache')
        .map((r) => r.stored_path)
    )
    for (const { file } of files) {
      if (totalBytes <= limit) break
      if (referenced.has(file)) continue
      try {
        const size = fs.statSync(file).size
        fs.unlinkSync(file)
        totalBytes -= size
      } catch {
        // ignore
      }
    }
    getLogger().info(`Artwork cache cleaned, now ${Math.round(totalBytes / 1024 / 1024)} MB`)
  }
}

function dirKeyExpr(dir: string): string {
  return path.resolve(dir)
}

export interface ArtworkResolution {
  url: string | null
  cacheFile: string | null
}