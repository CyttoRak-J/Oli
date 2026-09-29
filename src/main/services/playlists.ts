import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getLogger } from './logger'
import { toPlaylist, toPlaylistEntry } from './mappers'
import type { Database } from './database'
import type { Playlist, PlaylistEntry, SmartRule } from '@shared/types'

export interface PlaylistInput {
  name: string
  description?: string
  type?: 'manual' | 'smart'
  rules?: SmartRule[] | null
}

const RULE_FIELDS: Record<string, string> = {
  title: 'title',
  artist: 'artist',
  album: 'album',
  albumArtist: 'album_artist',
  genre: 'genre',
  composer: 'composer',
  year: 'year',
  duration: 'duration',
  bitrate: 'bitrate',
  format: 'format',
  rating: 'rating',
  playCount: 'play_count',
  addedAt: 'added_at',
  lastPlayed: 'last_played_at',
  favorite: 'favorite',
  trackNo: 'track_no',
  discNo: 'disc_no'
}

export class PlaylistService {
  constructor(private db: Database) {}

  // ------------------------------------------------------------------
  // CRUD
  // ------------------------------------------------------------------

  list(): Playlist[] {
    const rows = this.db.all<Record<string, unknown>>('SELECT * FROM playlists')
    return rows.map((row) =>
      toPlaylist(row, this.countTracks(String(row.id)), this.totalDuration(String(row.id)))
    )
  }

  get(id: string): Playlist | null {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM playlists WHERE id = ?', [id])
    return row ? toPlaylist(row, this.countTracks(id), this.totalDuration(id)) : null
  }

  create(input: PlaylistInput): Playlist | null {
    const id = randomUUID()
    const now = Date.now()
    const maxPos = Number(
      this.db.get<{ m: number }>('SELECT COALESCE(MAX(position), -1) AS m FROM playlists')?.m ?? -1
    )
    this.db.run(
      `INSERT INTO playlists (id, name, description, type, rules_json, folder_id, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      [
        id,
        input.name.trim(),
        (input.description ?? '').trim(),
        input.type ?? 'manual',
        input.rules && input.rules.length > 0 ? JSON.stringify(input.rules) : null,
        maxPos + 1,
        now,
        now
      ]
    )
    return this.get(id)
  }

  update(id: string, input: Partial<PlaylistInput>): Playlist | null {
    if (!this.db.get('SELECT id FROM playlists WHERE id = ?', [id])) return null
    const sets: string[] = []
    const params: unknown[] = []
    if (input.name !== undefined) {
      sets.push('name = ?')
      params.push(input.name.trim())
    }
    if (input.description !== undefined) {
      sets.push('description = ?')
      params.push(input.description.trim())
    }
    if (input.rules !== undefined) {
      sets.push('type = ?')
      params.push(input.rules && input.rules.length > 0 ? 'smart' : 'manual')
      sets.push('rules_json = ?')
      params.push(input.rules && input.rules.length > 0 ? JSON.stringify(input.rules) : null)
    }
    sets.push('updated_at = ?')
    params.push(Date.now())
    params.push(id)
    this.db.run(`UPDATE playlists SET ${sets.join(', ')} WHERE id = ?`, params)
    return this.get(id)
  }

  delete(id: string): void {
    this.db.run('DELETE FROM playlists WHERE id = ?', [id])
    this.db.run('DELETE FROM playlist_tracks WHERE playlist_id = ?', [id])
  }

  duplicate(id: string): Playlist | null {
    const source = this.get(id)
    if (!source) return null
    const copy = this.create({
      name: `${source.name} (Copy)`,
      description: source.description,
      type: source.type,
      rules: source.rules
    })
    if (!copy) return null
    if (source.type === 'manual') {
      const songIds = this.db
        .all<{ song_id: string }>(
          'SELECT song_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position',
          [id]
        )
        .map((r) => r.song_id)
      this.addTracks(copy.id, songIds)
    }
    return this.get(copy.id)
  }

  togglePin(playlistId: string): void {
    const row = this.db.get<{ pinned: number }>('SELECT pinned FROM playlists WHERE id = ?', [
      playlistId
    ])
    if (!row) return
    this.db.run('UPDATE playlists SET pinned = ? WHERE id = ?', [row.pinned ? 0 : 1, playlistId])
  }

  // ------------------------------------------------------------------
  // Tracks
  // ------------------------------------------------------------------

  countTracks(playlistId: string): number {
    const p = this.db.get<{ type: string }>('SELECT type FROM playlists WHERE id = ?', [playlistId])
    if (!p) return 0
    if (p.type === 'smart') {
      return this.evaluateSmartPlaylist(playlistId).length
    }
    return Number(
      this.db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM playlist_tracks WHERE playlist_id = ?',
        [playlistId]
      )?.n ?? 0
    )
  }

  private totalDuration(playlistId: string): number {
    const p = this.db.get<{ type: string }>('SELECT type FROM playlists WHERE id = ?', [playlistId])
    if (p?.type === 'smart') {
      // Smart playlists have no playlist_tracks rows (always showed 0:00).
      return this.evaluateSmartPlaylist(playlistId).reduce((sum, e) => sum + (e.track.duration || 0), 0)
    }
    const row = this.db.get<{ duration: number }>(
      `SELECT COALESCE(SUM(s.duration), 0) AS duration
       FROM playlist_tracks pt JOIN songs s ON s.id = pt.song_id
       WHERE pt.playlist_id = ?`,
      [playlistId]
    )
    return Number(row?.duration ?? 0)
  }

  entries(playlistId: string): PlaylistEntry[] {
    const playlist = this.get(playlistId)
    if (!playlist) return []
    if (playlist.type === 'smart') {
      return this.evaluateSmartPlaylist(playlistId)
    }
    return this.db
      .all<Record<string, unknown>>(
        `SELECT pt.playlist_id, pt.song_id, pt.position, pt.added_at, s.*
         FROM playlist_tracks pt JOIN songs s ON s.id = pt.song_id
         WHERE pt.playlist_id = ?
         ORDER BY pt.position ASC`,
        [playlistId]
      )
      .map(toPlaylistEntry)
  }

  addTracks(playlistId: string, songIds: string[]): number {
    const playlist = this.get(playlistId)
    if (!playlist || playlist.type === 'smart') return 0
    const existing = new Set(
      this.db
        .all<{ song_id: string }>(
          'SELECT song_id FROM playlist_tracks WHERE playlist_id = ?',
          [playlistId]
        )
        .map((r) => r.song_id)
    )
    const maxPos = Number(
      this.db.get<{ m: number }>(
        'SELECT COALESCE(MAX(position), -1) AS m FROM playlist_tracks WHERE playlist_id = ?',
        [playlistId]
      )?.m ?? -1
    )
    const tx = this.db.transaction()
    try {
      let added = 0
      for (const songId of songIds) {
        if (existing.has(songId)) continue
        // Also dedupes within this call (an imported M3U listing a file twice).
        existing.add(songId)
        this.db.run(
          'INSERT INTO playlist_tracks (playlist_id, song_id, position, added_at) VALUES (?, ?, ?, ?)',
          [playlistId, songId, maxPos + 1 + added, Date.now()]
        )
        added++
      }
      tx.commit()
      this.touch(playlistId)
      return added
    } catch (err) {
      tx.rollback()
      getLogger().warn('addTracks failed', err)
      return 0
    }
  }

  removeTracks(playlistId: string, songIds: string[]): void {
    const tx = this.db.transaction()
    try {
      for (const songId of songIds) {
        this.db.run('DELETE FROM playlist_tracks WHERE playlist_id = ? AND song_id = ?', [
          playlistId,
          songId
        ])
      }
      this.reindex(playlistId)
      tx.commit()
      this.touch(playlistId)
    } catch (err) {
      tx.rollback()
      getLogger().warn('removeTracks failed', err)
    }
  }

  reorder(playlistId: string, orderedSongIds: string[]): void {
    const tx = this.db.transaction()
    try {
      // position is part of the PRIMARY KEY (playlist_id, position): shifting
      // every row out of its slot first avoids UNIQUE collisions when tracks
      // swap places (a plain per-row UPDATE always collides on non-identity
      // permutations and silently fails).
      this.db.run(
        'UPDATE playlist_tracks SET position = position + 1000000 WHERE playlist_id = ?',
        [playlistId]
      )
      orderedSongIds.forEach((songId, idx) => {
        this.db.run(
          'UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND song_id = ?',
          [idx, playlistId, songId]
        )
      })
      this.reindex(playlistId)
      tx.commit()
      this.touch(playlistId)
    } catch (err) {
      tx.rollback()
      getLogger().warn('reorder failed', err)
    }
  }

  private reindex(playlistId: string): void {
    const rows = this.db.all<{ song_id: string }>(
      'SELECT song_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position',
      [playlistId]
    )
    rows.forEach((r, idx) => {
      this.db.run('UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND song_id = ?', [
        idx,
        playlistId,
        r.song_id
      ])
    })
  }

  private touch(playlistId: string): void {
    this.db.run('UPDATE playlists SET updated_at = ? WHERE id = ?', [Date.now(), playlistId])
  }

  // ------------------------------------------------------------------
  // Smart playlists
  // ------------------------------------------------------------------

  evaluateSmartPlaylist(playlistId: string): PlaylistEntry[] {
    const playlist = this.get(playlistId)
    if (!playlist || playlist.type !== 'smart') return []
    const { sql, params } = this.buildRuleSql(playlist.rules ?? [])
    if (!sql) return []
    const rows = this.db.all<Record<string, unknown>>(
      `SELECT ? AS playlist_id, s.id AS song_id, ROW_NUMBER() OVER (ORDER BY s.title) AS position,
              ? AS added_at, s.*
       FROM songs s
       WHERE s.missing = 0 AND ${sql}`,
      [playlistId, Date.now(), ...params]
    )
    return rows.map(toPlaylistEntry)
  }

  buildRuleSql(rules: SmartRule[]): { sql: string | null; params: unknown[] } {
    if (rules.length === 0) return { sql: null, params: [] }
    const clauses: string[] = []
    const params: unknown[] = []
    for (const rule of rules) {
      const column = RULE_FIELDS[rule.field]
      if (!column) continue
      const built = this.buildClause(column, rule)
      if (built) {
        clauses.push(built.clause)
        params.push(...built.params)
      }
    }
    return { sql: clauses.length ? clauses.join(' AND ') : null, params }
  }

  private buildClause(
    column: string,
    rule: SmartRule
  ): { clause: string; params: unknown[] } | null {
    const value = rule.value
    const op = rule.operator
    if (value === null || value === undefined || value === '') return null
    switch (op) {
      case 'between': {
        const arr = Array.isArray(value) ? value : [value]
        const a = arr[0]
        const b = arr[1]
        // A single value cannot form a range: fall back to an exact match
        // instead of the old `BETWEEN a AND 0` (which matches nothing).
        if (b === null || b === undefined || b === '') {
          return { clause: `${column} = ?`, params: [a] }
        }
        return { clause: `${column} BETWEEN ? AND ?`, params: [a, b] }
      }
      case 'matchesAny': {
        const items = (Array.isArray(value) ? value : [value]).filter(
          (v) => v !== null && v !== ''
        )
        if (items.length === 0) return null
        const placeholders = items.map(() => '?').join(', ')
        return {
          clause: `LOWER(COALESCE(CAST(${column} AS TEXT), '')) IN (${placeholders})`,
          params: items.map((v) => String(v).toLowerCase())
        }
      }
      case 'startsWith': {
        return {
          clause: `LOWER(COALESCE(CAST(${column} AS TEXT), '')) LIKE ?`,
          params: [`${String(value).toLowerCase()}%`]
        }
      }
      case 'contains':
      case 'notContains': {
        const opSql = op === 'contains' ? 'LIKE' : 'NOT LIKE'
        return {
          clause: `LOWER(COALESCE(CAST(${column} AS TEXT), '')) ${opSql} ?`,
          params: [`%${String(value).toLowerCase()}%`]
        }
      }
      case 'equals':
      case 'notEquals':
      case 'is':
      case 'isNot': {
        const opSql = op === 'equals' || op === 'is' ? '=' : '<>'
        if (typeof value === 'number') {
          return { clause: `${column} ${opSql} ?`, params: [value] }
        }
        return {
          clause: `LOWER(COALESCE(CAST(${column} AS TEXT), '')) ${opSql} ?`,
          params: [String(value).toLowerCase()]
        }
      }
      case 'before':
      case 'after':
      case 'greaterThan':
      case 'lessThan': {
        const opSql = op === 'before' || op === 'lessThan' ? '<' : '>'
        return { clause: `${column} ${opSql} ?`, params: [value as number] }
      }
      default:
        return null
    }
  }

  // ------------------------------------------------------------------
  // Import / export (.m3u / .m3u8)
  // ------------------------------------------------------------------

  importPlaylist(filePath: string, playlistName: string | null): Playlist | null {
    const name = playlistName ?? path.basename(filePath, path.extname(filePath))
    let content: string
    try {
      content = fs.readFileSync(filePath, 'utf-8')
    } catch (err) {
      getLogger().warn('Playlist import read failed', err)
      return null
    }
    // Many players write a UTF-8 BOM; it would glue onto the first line.
    const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/)
    const baseDir = path.dirname(filePath)
    const songIds: string[] = []
    for (const raw of lines) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const resolved = path.isAbsolute(line) ? path.resolve(line) : path.resolve(baseDir, line)
      // Exact path, then case-insensitive (Windows), then by file name when
      // the files moved. Resolved per line: the name fallback used to run
      // only when NOT A SINGLE line matched exactly, so partially relocated
      // playlists silently lost tracks. The name must follow a separator
      // ('%song.mp3' also matched 'other-song.mp3').
      const base = path.basename(line.replace(/\\/g, '/'))
      const match =
        this.db.get<{ id: string }>('SELECT id FROM songs WHERE path = ?', [resolved]) ??
        this.db.get<{ id: string }>('SELECT id FROM songs WHERE LOWER(path) = LOWER(?)', [
          resolved
        ]) ??
        (base
          ? this.db.get<{ id: string }>(
              'SELECT id FROM songs WHERE missing = 0 AND (LOWER(path) LIKE LOWER(?) OR LOWER(path) LIKE LOWER(?)) LIMIT 1',
              [`%\\${base}`, `%/${base}`]
            )
          : undefined)
      if (match) songIds.push(match.id)
    }
    const playlist = this.create({ name, type: 'manual' })
    if (playlist && songIds.length > 0) this.addTracks(playlist.id, songIds)
    return playlist
  }

  /**
   * ADDED: exportPlaylist was never implemented — only importPlaylist existed
   * (wired end-to-end through IPC and the Playlists page "Import" button),
   * even though the section comment above promised both and there's no
   * corresponding "Export" button anywhere. Writes a standard extended M3U8
   * (#EXTM3U / #EXTINF duration,artist - title / absolute path per track),
   * which is what every other player expects for interop.
   */
  exportPlaylist(playlistId: string, destPath: string): boolean {
    const playlist = this.get(playlistId)
    if (!playlist) return false
    const entries = this.entries(playlistId)
    const lines = ['#EXTM3U']
    for (const entry of entries) {
      const t = entry.track
      // Online (stream-only) tracks have no file to point to.
      if (!t.path) continue
      lines.push(`#EXTINF:${Math.round(t.duration)},${t.artist} - ${t.title}`)
      lines.push(t.path)
    }
    try {
      fs.writeFileSync(destPath, lines.join('\n') + '\n', 'utf-8')
      return true
    } catch (err) {
      getLogger().warn('Playlist export failed', err)
      return false
    }
  }
}
