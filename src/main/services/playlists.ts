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
    const lines = content.split(/\r?\n/)
    const baseDir = path.dirname(filePath)
    const songIds: string[] = []
    for (const raw of lines) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const resolved = path.isAbsolute(line) ? line : path.resolve(baseDir, line)
      const match =
        this.db.get<{ id: string }>('SELECT id FROM songs WHERE path = ?', [resolved]) ??
        this.db.get<{ id: string }>('SELECT id FROM songs WHERE LOWER(path) = LOWER(?)', [
          resolved
        ])
      if (match) songIds.push(match.id)
    }
    if (songIds.length === 0 && lines.length > 0) {
      // Fallback: resolve by file basename within the library
      for (const raw of lines) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        const base = path.basename(line)
        const match = this.db.get<{ id: string }>(
          'SELECT id FROM songs WHERE missing = 0 AND (path LIKE ? OR path LIKE ?) LIMIT 1',
          [`%${base}`, `%/${base}`]
        )
        if (match) songIds.push(match.id)
      }
    }
    const playlist = this.create({ name, type: 'manual' })
    if (playlist && songIds.length > 0) this.addTracks(playlist.id, songIds)
    return playlist
  }
}