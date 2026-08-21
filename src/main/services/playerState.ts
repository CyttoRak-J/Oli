import type { Database } from './database'
import { randomId } from '../util/hash'
import { getLogger } from './logger'
import { toQueueEntry, toTrack } from './mappers'
import type { PlaybackHistoryEntry, PlaybackState, QueueEntry, Track } from '@shared/types'

/** In-main canonical playback state shared with tray, mini player and windows. */
export interface PlaybackSnapshot {
  songId: string | null
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'ended'
  currentTime: number
  duration: number
  volume: number
  muted: boolean
  shuffle: boolean
  repeat: 'off' | 'queue' | 'one'
  queueIndex: number
  queueLength: number
  updatedAt: number
  /** Display metadata for online tracks (YouTube etc.); local tracks read the songs table. */
  title?: string | null
  artist?: string | null
  artworkUrl?: string | null
}

export class PlaybackStateStore {
  private lastSongId: string | null = null
  private snapshot: PlaybackSnapshot = {
    songId: null,
    status: 'idle',
    currentTime: 0,
    duration: 0,
    volume: 0.8,
    muted: false,
    shuffle: false,
    repeat: 'off',
    queueIndex: 0,
    queueLength: 0,
    updatedAt: 0,
    title: null,
    artist: null,
    artworkUrl: null
  }

  constructor(private db: Database) {}

  update(state: Partial<PlaybackSnapshot>): PlaybackSnapshot {
    this.snapshot = { ...this.snapshot, ...state, updatedAt: Date.now() }
    return this.snapshot
  }

  get(): PlaybackSnapshot {
    return this.snapshot
  }

  toIpc(): PlaybackState {
    const s = this.snapshot
    return {
      songId: s.songId,
      status: s.status,
      currentTime: s.currentTime,
      duration: s.duration,
      volume: s.volume,
      muted: s.muted,
      shuffle: s.shuffle,
      repeat: s.repeat,
      positionMeta: { queueIndex: s.queueIndex, queueLength: s.queueLength },
      timestamp: s.updatedAt,
      title: s.title ?? null,
      artist: s.artist ?? null,
      artworkUrl: s.artworkUrl ?? null
    }
  }

  /** Records a history row when a new song starts playing. */
  recordPlayIfNew(): void {
    if (!this.snapshot.songId) return
    if (this.snapshot.songId === this.lastSongId) return
    this.lastSongId = this.snapshot.songId
    try {
      this.db.run(
        `INSERT INTO playback_history (id, song_id, played_at, completed, duration_seconds, position_seconds, title, artist, artwork_url)
         VALUES (?, ?, ?, 0, ?, 0, ?, ?, ?)`,
        [
          randomId(),
          this.snapshot.songId,
          Date.now(),
          Math.round(this.snapshot.duration || 0),
          this.snapshot.title ?? null,
          this.snapshot.artist ?? null,
          this.snapshot.artworkUrl ?? null
        ]
      )
      this.db.run(
        `UPDATE songs SET play_count = play_count + 1, last_played_at = ? WHERE id = ?`,
        [Date.now(), this.snapshot.songId]
      )
      this.db.run('INSERT INTO recent_activity (id, type, item_id, at) VALUES (?, ?, ?, ?)', [
        randomId(),
        'play',
        this.snapshot.songId,
        Date.now()
      ])
    } catch (err) {
      getLogger().warn('Failed to record playback history', err)
    }
  }

  /** Marks the most recent history row complete (used on natural end). */
  markLastCompleted(): void {
    const row = this.db.get<{ id: string }>(
      'SELECT id FROM playback_history ORDER BY played_at DESC LIMIT 1'
    )
    if (!row) return
    try {
      this.db.run('UPDATE playback_history SET completed = 1 WHERE id = ?', [row.id])
    } catch (err) {
      getLogger().warn('Failed to mark history complete', err)
    }
  }

  updatePlayedPosition(seconds: number): void {
    const row = this.db.get<{ id: string }>(
      'SELECT id FROM playback_history ORDER BY played_at DESC LIMIT 1'
    )
    if (row) {
      try {
        this.db.run('UPDATE playback_history SET position_seconds = ? WHERE id = ?', [
          Math.round(seconds),
          row.id
        ])
      } catch {
        // ignore
      }
    }
  }
}

export class QueueService {
  constructor(private db: Database) {}

  save(entries: Array<{ id: string; songId: string; via?: string | null; track?: Track }>): void {
    const tx = this.db.transaction()
    try {
      this.db.run('DELETE FROM queue')
      entries.forEach((entry, index) => {
        const isOnline = entry.track && !entry.track.path && entry.track.id.startsWith('youtube:')
        this.db.run(
          'INSERT INTO queue (id, song_id, position, queued_at, via, track_json) VALUES (?, ?, ?, ?, ?, ?)',
          [
            entry.id ?? randomId(),
            entry.songId,
            index,
            Date.now(),
            entry.via ?? null,
            isOnline ? JSON.stringify(entry.track) : null
          ]
        )
      })
      tx.commit()
    } catch (err) {
      tx.rollback()
      getLogger().error('Queue save failed', err)
    }
  }

  load(): QueueEntry[] {
    const rows = this.db.all<Record<string, unknown>>(
      `SELECT q.*, s.*,
              q.track_json AS queue_track_json
       FROM queue q
       LEFT JOIN songs s ON s.id = q.song_id
       ORDER BY q.position ASC`
    )
    return rows.map((row) => {
      // Online track: reconstruct from stored JSON
      if (row.queue_track_json && !row.path) {
        try {
          const track = JSON.parse(String(row.queue_track_json)) as Track
          return {
            id: String(row.id),
            songId: String(row.song_id),
            position: Number(row.position ?? 0),
            queuedAt: Number(row.queued_at ?? 0),
            track,
            via: row.via != null ? String(row.via) : null
          }
        } catch { /* fall through to toQueueEntry */ }
      }
      return toQueueEntry(row)
    })
  }

  clear(): void {
    this.db.run('DELETE FROM queue')
  }
}

export class HistoryService {
  constructor(private db: Database) {}

  recent(limit = 50): PlaybackHistoryEntry[] {
    return this.rawRecent(limit).map((row) => ({
      id: String(row.history_id ?? row.id),
      songId: String(row.song_id),
      playedAt: Number(row.played_at ?? 0),
      completed: row.completed === 1 || row.completed === true || row.completed === '1' || row.completed === 'true',
      durationSeconds: Number(row.duration_seconds ?? 0),
      track: row.song_id && row.path ? toTrack(row) : this.onlineTrack(row)
    }))
  }

  /** Minimal display Track for online entries (YouTube etc.) with no local file. */
  private onlineTrack(row: Record<string, unknown>): Track | undefined {
    if (!row.song_id) return undefined
    const title = String(row.history_title ?? row.song_id)
    const artist = String(row.history_artist ?? '')
    return {
      id: String(row.song_id),
      title,
      artist,
      artistId: null,
      albumArtist: artist,
      album: '',
      albumId: null,
      genre: null,
      composer: null,
      year: null,
      releaseDate: null,
      trackNo: null,
      discNo: null,
      isrc: null,
      rating: null,
      duration: Number(row.duration_seconds ?? 0),
      bitrate: null,
      sampleRate: null,
      bitDepth: null,
      channels: null,
      codec: null,
      format: null,
      fileSize: null,
      path: '',
      folderId: null,
      libraryId: null,
      hash: null,
      replayGain: null,
      replayGainAlbum: null,
      lyrics: null,
      hasEmbeddedArtwork: false,
      addedAt: 0,
      modifiedAt: 0,
      lastPlayedAt: null,
      playCount: null,
      favorite: false,
      missing: true,
      error: null,
      artworkUrl: row.history_artwork_url != null ? String(row.history_artwork_url) : null
    }
  }

  private rawRecent(limit: number): Array<Record<string, unknown>> {
    return this.db.all(
      `SELECT
         ph.id AS history_id,
         ph.song_id,
         ph.played_at,
         ph.completed,
         ph.duration_seconds,
         ph.position_seconds,
         ph.title AS history_title,
         ph.artist AS history_artist,
         ph.artwork_url AS history_artwork_url,
         s.*
       FROM playback_history ph
       LEFT JOIN songs s ON s.id = ph.song_id
       ORDER BY ph.played_at DESC
       LIMIT ${Math.max(1, limit)}`
    )
  }

  clear(): void {
    const snapshot = JSON.stringify(this.rawRecent(5000))
    if (snapshot !== '[]') {
      this.db.run('INSERT INTO history_backups (id, json, created_at) VALUES (?, ?, ?)', [
        randomId(),
        snapshot,
        Date.now()
      ])
      this._trimBackups()
    }
    this.db.run('DELETE FROM playback_history')
  }

  backups(): Array<{ id: string; createdAt: number }> {
    return this.db.all('SELECT id, created_at FROM history_backups ORDER BY created_at DESC')
  }

  restoreBackup(id: string): boolean {
    const row = this.db.get<{ json: string }>(
      'SELECT json FROM history_backups WHERE id = ?',
      [id]
    )
    if (!row) return false
    try {
      const rows = JSON.parse(row.json) as Array<Record<string, unknown>>
      const tx = this.db.transaction()
      for (const r of rows) {
        this.db.run(
          `INSERT INTO playback_history (id, song_id, played_at, completed, duration_seconds, position_seconds, title, artist, artwork_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
          [r.id, r.song_id, r.played_at, r.completed ?? 0, r.duration_seconds ?? 0, r.position_seconds ?? 0, r.title ?? null, r.artist ?? null, r.artwork_url ?? null]
        )
      }
      tx.commit()
      return true
    } catch (err) {
      getLogger().warn('History restore failed', err)
      return false
    }
  }

  private _trimBackups(): void {
    const keep = 5
    const rows = this.db.all<{ id: string }>(
      'SELECT id FROM history_backups ORDER BY created_at DESC'
    )
    rows.slice(keep).forEach((r) => this.db.run('DELETE FROM history_backups WHERE id = ?', [r.id]))
  }
}