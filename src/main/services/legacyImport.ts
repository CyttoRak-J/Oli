import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Database as SqlJsDatabase } from 'sql.js'
import { loadSqlJs, type Database } from './database'
import { getLogger, errorOf } from './logger'

const DONE_KEY = 'legacyImportDone'

export interface LegacyImportResult {
  /** Directory the data was imported from, or null when nothing was merged. */
  source: string | null
  /** Human-readable summary of what was merged (e.g. "queue (832)"). */
  merged: string[]
  /** True when the one-time import already ran on a previous start. */
  skipped: boolean
}

/**
 * One-time recovery for the rename chain "Cytto's Play" -> "Oil" -> "Oli".
 *
 * The final rename copies the legacy `library.sqlite` next to the new user
 * data directory. If that copy is interrupted (e.g. the app is killed while
 * copying) the new database fails its integrity check on the next launch and
 * the app reinitializes an EMPTY database, losing settings, queue, history,
 * favorites and playlists. The legacy copy stays intact, so on every start
 * (until the flag below is set) we merge anything still missing from the
 * legacy databases into the live one:
 *
 *   - settings: only keys the live DB does not have yet (never clobber)
 *   - queue:    replaced when the legacy queue is non-empty and bigger
 *   - playback_history / downloads / favorites / playlists /
 *     playlist_tracks / search_history / library_locations: merged, deduped
 *
 * The merge is atomic (single transaction) and explicitly flushed to disk
 * before the app continues, so it survives a crash right after startup.
 */
export async function importLegacyData(
  db: Database,
  legacyDirs: string[]
): Promise<LegacyImportResult> {
  const log = getLogger()
  const done = db.get<{ value: string }>(
    `SELECT value FROM application_state WHERE key = ?`,
    [DONE_KEY]
  )
  if (done) {
    return { source: null, merged: [], skipped: true }
  }

  const SQL = await loadSqlJs()

  for (const dir of legacyDirs) {
    const file = path.join(dir, 'library.sqlite')
    if (!fs.existsSync(file)) continue
    if (path.resolve(dir) === path.resolve(path.dirname(file))) {
      // never import from the live directory itself
      continue
    }
    let legacy: SqlJsDatabase
    try {
      const bytes = fs.readFileSync(file)
      legacy = new SQL.Database(bytes)
    } catch (err) {
      log.warn(`Legacy import: cannot open ${file}`, errorOf(err))
      continue
    }
    let ok = false
    try {
      const res = legacy.exec('PRAGMA quick_check')
      ok = res?.[0]?.values?.[0]?.[0] === 'ok'
    } catch {
      // treat as corrupt
    }
    if (!ok) {
      log.warn(`Legacy import: ${file} failed integrity check, skipping`)
      legacy.close()
      continue
    }

    const merged: string[] = []
    const tx = db.transaction()
    try {
      // ------------------------------------------------------------ settings
      const existingKeys = new Set(
        db.all<{ key: string }>('SELECT key FROM settings').map((r) => r.key)
      )
      let nSettings = 0
      for (const row of legacy.exec('SELECT key, value FROM settings')[0]?.values ?? []) {
        const key = String(row[0])
        if (!existingKeys.has(key)) {
          db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [
            key,
            row[1]
          ])
          nSettings++
        }
      }
      if (nSettings > 0) merged.push(`settings (+${nSettings})`)

      // ----------------------------------------------------------------- queue
      const legacyQueue =
        legacy.exec('SELECT id, song_id, position, queued_at, via FROM queue ORDER BY position')[0]?.values ?? []
      const liveQueueCount = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM queue')?.n ?? 0
      if (legacyQueue.length > 0 && legacyQueue.length > liveQueueCount) {
        db.run('DELETE FROM queue')
        for (const row of legacyQueue) {
          db.run(
            'INSERT OR IGNORE INTO queue (id, song_id, position, queued_at, via) VALUES (?, ?, ?, ?, ?)',
            row
          )
        }
        merged.push(`queue (${legacyQueue.length})`)
      }

      // ------------------------------------------------------- playback_history
      const historyIds = new Set(
        db.all<{ id: string }>('SELECT id FROM playback_history').map((r) => r.id)
      )
      let nHistory = 0
      for (const row of legacy.exec(
        'SELECT id, song_id, played_at, completed, duration_seconds, position_seconds FROM playback_history'
      )[0]?.values ?? []) {
        if (!historyIds.has(String(row[0]))) {
          db.run(
            'INSERT OR IGNORE INTO playback_history (id, song_id, played_at, completed, duration_seconds, position_seconds) VALUES (?, ?, ?, ?, ?, ?)',
            row
          )
          nHistory++
        }
      }
      if (nHistory > 0) merged.push(`history (+${nHistory})`)

      // -------------------------------------------------------------- downloads
      const downloadIds = new Set(
        db.all<{ id: string }>('SELECT id FROM downloads').map((r) => r.id)
      )
      let nDownloads = 0
      for (const row of legacy.exec(
        'SELECT id, title, url, dest_path, state, progress, total_bytes, downloaded_bytes, speed, eta_seconds, error, created_at, updated_at FROM downloads'
      )[0]?.values ?? []) {
        if (!downloadIds.has(String(row[0]))) {
          db.run(
            'INSERT OR IGNORE INTO downloads (id, title, url, dest_path, state, progress, total_bytes, downloaded_bytes, speed, eta_seconds, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            row
          )
          nDownloads++
        }
      }
      if (nDownloads > 0) merged.push(`downloads (+${nDownloads})`)

      // -------------------------------------------------------------- favorites
      const favKeys = new Set(
        db
          .all<{ item_type: string; item_id: string }>(
            'SELECT item_type, item_id FROM favorites'
          )
          .map((r) => `${r.item_type}\u0000${r.item_id}`)
      )
      let nFavorites = 0
      for (const row of legacy.exec(
        'SELECT id, item_type, item_id, created_at FROM favorites'
      )[0]?.values ?? []) {
        const key = `${String(row[1])}\u0000${String(row[2])}`
        if (!favKeys.has(key)) {
          db.run(
            'INSERT OR IGNORE INTO favorites (id, item_type, item_id, created_at) VALUES (?, ?, ?, ?)',
            row
          )
          nFavorites++
        }
      }
      if (nFavorites > 0) merged.push(`favorites (+${nFavorites})`)

      // -------------------------------------------------------------- playlists
      const playlistIds = new Set(
        db.all<{ id: string }>('SELECT id FROM playlists').map((r) => r.id)
      )
      let nPlaylists = 0
      for (const row of legacy.exec(
        'SELECT id, name, description, type, rules_json, folder_id, position, pinned, favorite, created_at, updated_at FROM playlists'
      )[0]?.values ?? []) {
        if (!playlistIds.has(String(row[0]))) {
          db.run(
            'INSERT OR IGNORE INTO playlists (id, name, description, type, rules_json, folder_id, position, pinned, favorite, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            row
          )
          nPlaylists++
        }
      }
      if (nPlaylists > 0) merged.push(`playlists (+${nPlaylists})`)

      const trackKeys = new Set(
        db
          .all<{ playlist_id: string; position: number }>(
            'SELECT playlist_id, position FROM playlist_tracks'
          )
          .map((r) => `${r.playlist_id}\u0000${r.position}`)
      )
      let nTracks = 0
      for (const row of legacy.exec(
        'SELECT playlist_id, song_id, position, added_at FROM playlist_tracks'
      )[0]?.values ?? []) {
        const key = `${String(row[0])}\u0000${String(row[2])}`
        if (!trackKeys.has(key)) {
          db.run(
            'INSERT OR IGNORE INTO playlist_tracks (playlist_id, song_id, position, added_at) VALUES (?, ?, ?, ?)',
            row
          )
          nTracks++
        }
      }
      if (nTracks > 0) merged.push(`playlist tracks (+${nTracks})`)

      // ---------------------------------------------------------- search_history
      const searchIds = new Set(
        db.all<{ id: string }>('SELECT id FROM search_history').map((r) => r.id)
      )
      let nSearch = 0
      for (const row of legacy.exec(
        'SELECT id, query, pinned, created_at FROM search_history'
      )[0]?.values ?? []) {
        if (!searchIds.has(String(row[0]))) {
          db.run(
            'INSERT OR IGNORE INTO search_history (id, query, pinned, created_at) VALUES (?, ?, ?, ?)',
            row
          )
          nSearch++
        }
      }
      if (nSearch > 0) merged.push(`search history (+${nSearch})`)

      // ---------------------------------------------------- library_locations
      const locationIds = new Set(
        db.all<{ id: string }>('SELECT id FROM library_locations').map((r) => r.id)
      )
      let nLocations = 0
      for (const row of legacy.exec(
        'SELECT id, path, name, added_at, last_scan_at FROM library_locations'
      )[0]?.values ?? []) {
        if (!locationIds.has(String(row[0]))) {
          db.run(
            'INSERT OR IGNORE INTO library_locations (id, path, name, added_at, last_scan_at) VALUES (?, ?, ?, ?, ?)',
            row
          )
          nLocations++
        }
      }
      if (nLocations > 0) merged.push(`library locations (+${nLocations})`)

      db.run(
        `INSERT INTO application_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [DONE_KEY, String(Date.now())]
      )
      tx.commit()
      // Persist immediately: a crash before the 4s debounce would otherwise
      // restart the import (harmless thanks to the flag, but wasteful).
      db.flushToDisk()
    } catch (err) {
      tx.rollback()
      log.warn(`Legacy import from ${dir} failed`, errorOf(err))
      legacy.close()
      continue
    }
    legacy.close()
    log.info(`Legacy import from ${dir}: ${merged.join(', ') || 'nothing new'}`)
    return { source: dir, merged, skipped: false }
  }

  return { source: null, merged: [], skipped: false }
}