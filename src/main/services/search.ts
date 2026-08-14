import { randomId } from '../util/hash'
import { getLogger } from './logger'
import { toTrack } from './mappers'
import { fuzzyScore, normalizeText } from './text'
import type { Database } from './database'
import type { ProviderService } from './provider'
import type { SettingsStore } from './settingsStore'
import type { OnlineSearchResult, SearchFilters, SearchResults, Track } from '@shared/types'

const LOCAL_LIMIT = 60

function escapeFts(input: string): string {
  return input
    .replace(/[()"*':^]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export class SearchService {
  private hasFts5: boolean

  constructor(
    private db: Database,
    private providers: ProviderService,
    private settings: SettingsStore
  ) {
    this.hasFts5 = db
      .all<{ name: string }>('SELECT compile_options AS name FROM pragma_compile_options')
      .some((r) => r.name === 'ENABLE_FTS5')
  }

  // ------------------------------------------------------------------
  // Main search entry point
  // ------------------------------------------------------------------

  /**
   * Streamed search: local library + suggestions are computed instantly and
   * resolved in `partial`; online provider results arrive via the `online`
   * promise (pushed to the renderer as a `search:online` event when ready).
   */
  runStreaming(
    query: string,
    filters: SearchFilters = {},
    record = false
  ): { partial: Promise<SearchResults>; online: Promise<OnlineSearchResult[]> } {
    const q = normalizeText(query)
    const partial: SearchResults = { local: [], online: [], suggestions: [] }
    if (q && record) this.recordSearch(query)

    if (q && filters.library !== false) {
      const local = this.searchLocal(q, LOCAL_LIMIT)
      partial.local = local.tracks
      partial.suggestions = local.suggestions.slice(0, 8)
    }

    const cfg = {
      spotifyClientId: this.settings.get('spotifyClientId'),
      spotifyClientSecret: this.settings.get('spotifyClientSecret'),
      youtubeApiKey: this.settings.get('youtubeApiKey'),
      acoustidApiKey: this.settings.get('acoustidApiKey')
    }
    const online = (async () => {
      if (!q) return []
      const out: OnlineSearchResult[] = []
      if (filters.spotify !== false && this.providers.isSpotifyConfigured(cfg)) {
        try {
          out.push(...(await this.providers.searchSpotify(query, cfg)))
        } catch (err) {
          getLogger().debug('Spotify search failed', err)
        }
      }
      if (filters.youtube !== false && this.providers.isYouTubeConfigured(cfg)) {
        try {
          out.push(...(await this.providers.searchYouTube(query, cfg)))
        } catch (err) {
          getLogger().debug('YouTube search failed', err)
        }
      }
      return out
    })()

    return { partial: Promise.resolve(partial), online }
  }

  /** Aggregated search: local instantly, online awaited (used by non-streaming callers). */
  async search(
    query: string,
    _limit = LOCAL_LIMIT,
    filters: SearchFilters = {},
    record = false
  ): Promise<SearchResults> {
    const { partial, online } = this.runStreaming(query, filters, record)
    const results = await partial
    results.online = await online
    return results
  }

  /**
   * Local library search: FTS5 when available, LIKE otherwise, with a
   * filename/folder-path pass, merged and re-ranked with fuzzy scoring.
   */
  searchLocal(query: string, limit = LOCAL_LIMIT): { tracks: Track[]; suggestions: string[] } {
    const q = query.trim()
    if (!q) return { tracks: [], suggestions: [] }
    const scored: Array<{ track: Track; score: number }> = []
    const seen = new Set<string>()

    const push = (track: Track, extraBoost = 0): void => {
      if (seen.has(track.id)) return
      const score = fuzzyScore(q, track.title) * 1.0 + fuzzyScore(q, track.artist) * 0.6
      if (score < 0.15) return
      scored.push({ track, score: score + extraBoost })
      seen.add(track.id)
    }

    if (this.hasFts5) {
      try {
        const matchExpr = escapeFts(q)
          .split(' ')
          .filter(Boolean)
          .map((w) => `${w}*`)
          .join(' OR ')
        if (matchExpr) {
          const rows = this.db.all<Record<string, unknown>>(
            `SELECT s.* FROM songs_fts f
             JOIN songs s ON s.rowid = f.rowid
             WHERE songs_fts MATCH ? AND s.missing = 0
             ORDER BY bm25(songs_fts) LIMIT 200`,
            [matchExpr]
          )
          for (const row of rows) push(toTrack(row), 0.15)
        }
      } catch (err) {
        getLogger().debug('FTS search failed, falling back to LIKE', err)
        this.hasFts5 = false
      }
    }

    if (!this.hasFts5) {
      const like = `%${q}%`
      const rows = this.db.all<Record<string, unknown>>(
        `SELECT * FROM songs
         WHERE missing = 0 AND (
           LOWER(title) LIKE ? OR LOWER(artist) LIKE ? OR LOWER(album) LIKE ? OR
           LOWER(genre) LIKE ? OR LOWER(album_artist) LIKE ? OR LOWER(composer) LIKE ?
         )
         LIMIT 300`,
        [like, like, like, like, like, like]
      )
      for (const row of rows) push(toTrack(row))
    }

    // Filename / folder path search
    if (q.length >= 3) {
      const like = `%${q.replace(/\//g, '\\')}%`
      const rows = this.db.all<Record<string, unknown>>(
        `SELECT * FROM songs WHERE missing = 0 AND LOWER(path) LIKE ?
         LIMIT 100`,
        [like]
      )
      for (const row of rows) push(toTrack(row), 0.05)
    }

    scored.sort((a, b) => b.score - a.score)
    return { tracks: scored.slice(0, limit).map((s) => s.track), suggestions: this.suggestions(q) }
  }

  suggestions(query: string): string[] {
    const q = normalizeText(query)
    if (!q) return []
    const fromHistory = this.db.all<{ query: string }>(
      'SELECT query FROM search_history WHERE LOWER(query) LIKE ? ORDER BY pinned DESC, created_at DESC LIMIT 10',
      [`${q}%`]
    )
    const fromTitles = this.db.all<{ title: string }>(
      `SELECT title FROM songs WHERE missing = 0 AND LOWER(title) LIKE ? LIMIT 8`,
      [`${q}%`]
    )
    const seen = new Set<string>()
    const out: string[] = []
    for (const raw of [...fromHistory, ...fromTitles]) {
      const text = (raw as { query?: string }).query ?? (raw as { title?: string }).title ?? ''
      const norm = normalizeText(text)
      if (norm && !seen.has(norm)) {
        seen.add(norm)
        out.push(text)
      }
    }
    return out.slice(0, 12)
  }

  // ------------------------------------------------------------------
  // Search history
  // ------------------------------------------------------------------

  recordSearch(query: string): void {
    const trimmed = query.trim().slice(0, 200)
    if (!trimmed) return
    try {
      this.db.run(
        'INSERT OR IGNORE INTO search_history (id, query, pinned, created_at) VALUES (?, ?, 0, ?)',
        [randomId(), trimmed, Date.now()]
      )
      // keep history bounded
      const excess = this.db.all<{ id: string }>(
        'SELECT id FROM search_history WHERE pinned = 0 ORDER BY created_at DESC LIMIT -1 OFFSET 50'
      )
      for (const row of excess) this.db.run('DELETE FROM search_history WHERE id = ?', [row.id])
    } catch {
      // ignore
    }
  }

  history(): Array<{ id: string; query: string; pinned: boolean; createdAt: number }> {
    return this.db.all(
      'SELECT id, query, pinned, created_at FROM search_history ORDER BY pinned DESC, created_at DESC LIMIT 60'
    )
  }

  clearHistory(): void {
    this.db.run('DELETE FROM search_history')
  }

  removeHistoryEntry(id: string): void {
    this.db.run('DELETE FROM search_history WHERE id = ?', [id])
  }

  pinHistoryEntry(id: string, pinned: boolean): void {
    this.db.run('UPDATE search_history SET pinned = ? WHERE id = ?', [pinned ? 1 : 0, id])
  }
}