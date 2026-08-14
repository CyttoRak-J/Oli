import { getLogger } from './logger'
import type { Database } from './database'
import type { LyricsData, Track } from '@shared/types'

const LRCLIB_ENDPOINT = 'https://lrclib.net/api/get'
const USER_AGENT = 'CyttoPlay/1.0.0 (https://github.com/CyttosPlay/CyttosPlay)'

export interface LyricsProvider {
  name: string
  fetch: (track: { artist: string; title: string; album?: string; duration?: number }) => Promise<LyricsData | null>
}

/**
 * LRCLIB — an open, free lyrics API that publishes synchronized and
 * unsynchronized lyrics with explicit API documentation and licensing. Access
 * is authorized by its public API terms; results are cached locally and never
 * re-fetched unless the user asks for a refresh.
 */
class LrclibProvider implements LyricsProvider {
  name = 'LRCLIB'

  async fetch(track: {
    artist: string
    title: string
    album?: string
    duration?: number
  }): Promise<LyricsData | null> {
    const params = new URLSearchParams({
      artist_name: track.artist,
      track_name: track.title
    })
    if (track.album) params.set('album_name', track.album)
    if (track.duration) params.set('duration', String(Math.round(track.duration)))
    const url = `${LRCLIB_ENDPOINT}?${params.toString()}`
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: controller.signal
      })
      clearTimeout(timer)
      if (!res.ok) return null
      const body = (await res.json()) as { syncedLyrics?: string; plainLyrics?: string }
      const synced = body.syncedLyrics?.trim() ?? ''
      const plain = body.plainLyrics?.trim() ?? ''
      const lyrics = synced || plain
      if (!lyrics) return null
      return {
        synced: Boolean(synced),
        source: 'LRCLIB',
        lyrics,
        fetchedAt: Date.now()
      }
    } catch (err) {
      getLogger().debug('LRCLIB request failed', err)
      return null
    }
  }
}

export class LyricsService {
  private providers: LyricsProvider[] = []

  constructor(private db: Database, private onlineEnabled: () => boolean) {
    this.providers.push(new LrclibProvider())
  }

  private embedded(track: Track): LyricsData | null {
    if (!track.lyrics || track.lyrics.trim().length === 0) return null
    return { synced: false, source: 'embedded', lyrics: track.lyrics, fetchedAt: Date.now() }
  }

  private cached(songId: string): LyricsData | null {
    const row = this.db.get<{ source: string; synced: number; lyrics: string; fetched_at: number }>(
      'SELECT source, synced, lyrics, fetched_at FROM lyrics_cache WHERE song_id = ?',
      [songId]
    )
    if (!row) return null
    return {
      synced: row.synced === 1,
      source: row.source ?? null,
      lyrics: row.lyrics,
      fetchedAt: Number(row.fetched_at)
    }
  }

  private cache(songId: string, data: LyricsData): void {
    this.db.run(
      `INSERT INTO lyrics_cache (song_id, source, synced, lyrics, fetched_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(song_id) DO UPDATE SET
         source = excluded.source, synced = excluded.synced,
         lyrics = excluded.lyrics, fetched_at = excluded.fetched_at`,
      [songId, data.source, data.synced ? 1 : 0, data.lyrics, data.fetchedAt]
    )
  }

  /**
   * Lyrics resolution order: embedded -> local cache -> online providers.
   * `force` bypasses the cache (manual refresh).
   */
  async getLyrics(track: Track, force = false): Promise<LyricsData | null> {
    if (!force) {
      const embedded = this.embedded(track)
      if (embedded) return embedded
      const cached = this.cached(track.id)
      if (cached) return cached
    }
    if (!this.onlineEnabled()) return this.cached(track.id)
    for (const provider of this.providers) {
      const result = await provider.fetch({
        artist: track.artist,
        title: track.title,
        album: track.album,
        duration: track.duration
      })
      if (result) {
        this.cache(track.id, result)
        return result
      }
    }
    // Cache a negative result to avoid hammering the API
    this.db.run(
      'INSERT OR IGNORE INTO lyrics_cache (song_id, source, synced, lyrics, fetched_at) VALUES (?, ?, 0, ?, ?)',
      [track.id, null, '', Date.now()]
    )
    return null
  }
}