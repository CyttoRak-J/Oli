import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import type { Database } from './database'
import type { ProviderConfig, ProviderService, RichTrackMeta } from './provider'
import type { LibraryService } from './library'
import type { MetadataOpsService } from './metadataOps'
import { getLogger } from './logger'
import { ytVideoIdFromUrl } from './downloads'
import type { AttentionItem, FixProgress, FixResult, TrackTagInput } from '@shared/types'

/** Pause between lookups so MusicBrainz/iTunes rate limits are not tripped. */
const LOOKUP_GAP_MS = 400

/** Files often carry the YouTube id in brackets: "Song Name [dQw4w9WgXcQ].m4a". */
function ytVideoIdFromFileName(filePath: string): string | null {
  const m = /\[([A-Za-z0-9_-]{11})\]/.exec(filePath)
  return m?.[1] ?? null
}

/**
 * Re-resolve and re-embed metadata for downloaded YouTube files ("fix
 * metadata"). Each file's origin (video id, source provider, which fields
 * are present) is recorded in `yt_file_meta` at download time; files from
 * before that table existed are matched through the downloads table.
 */
export class MetaFixService extends EventEmitter {
  private busy = false

  constructor(
    private db: Database,
    private providers: ProviderService,
    private library: LibraryService,
    private metadataOps: MetadataOpsService,
    private providerConfig: () => ProviderConfig
  ) {
    super()
  }

  /**
   * All library files that originate from YouTube (video id resolvable),
   * plus any recorded yt_file_meta paths that are still on disk.
   */
  private youtubeFiles(): Array<{ path: string; songId: string | null; title: string; videoId: string }> {
    const metaRows = new Map<string, { video_id: string; yt_title: string | null }>()
    for (const row of this.db.all<Record<string, unknown>>('SELECT * FROM yt_file_meta')) {
      metaRows.set(String(row.path), {
        video_id: String(row.video_id),
        yt_title: row.yt_title ? String(row.yt_title) : null
      })
    }
    const dlByPath = new Map<string, { url: string; title: string }>()
    for (const row of this.db.all<Record<string, unknown>>(
      "SELECT dest_path, url, title FROM downloads WHERE dest_path IS NOT NULL AND dest_path != ''"
    )) {
      const p = String(row.dest_path)
      if (!dlByPath.has(p)) {
        dlByPath.set(p, { url: String(row.url ?? ''), title: String(row.title ?? '') })
      }
    }
    const out: Array<{ path: string; songId: string | null; title: string; videoId: string }> = []
    const seen = new Set<string>()
    const songs = this.db.all<Record<string, unknown>>(
      'SELECT id, path, title, composer, has_embedded_artwork FROM songs WHERE missing = 0'
    )
    for (const song of songs) {
      const path = String(song.path)
      if (!fs.existsSync(path)) continue
      const fm = metaRows.get(path)
      const dl = dlByPath.get(path)
      const videoId = fm?.video_id ?? (dl ? ytVideoIdFromUrl(dl.url) : null)
      if (!videoId) continue
      seen.add(path)
      out.push({
        path,
        songId: String(song.id),
        title: fm?.yt_title ?? dl?.title ?? String(song.title ?? ''),
        videoId
      })
    }
    for (const row of this.db.all<Record<string, unknown>>('SELECT * FROM yt_file_meta')) {
      const path = String(row.path)
      if (seen.has(path) || !fs.existsSync(path)) continue
      out.push({ path, songId: null, title: row.yt_title ? String(row.yt_title) : '', videoId: String(row.video_id) })
    }
    return out
  }

  /** Library files that are missing cover/composer and can still be fixed. */
  attention(): AttentionItem[] {
    const incomplete = new Set(
      this.db
        .all<Record<string, unknown>>(
          `SELECT path FROM songs
           WHERE missing = 0
             AND (composer IS NULL OR composer = '' OR has_embedded_artwork = 0)`
        )
        .map((r) => String(r.path))
    )
    const out: AttentionItem[] = []
    for (const f of this.youtubeFiles()) {
      if (!incomplete.has(f.path)) continue
      const reasons: string[] = []
      const song = this.db.get<{ composer: unknown; has_embedded_artwork: unknown }>(
        'SELECT composer, has_embedded_artwork FROM songs WHERE path = ?',
        [f.path]
      )
      if (!song?.composer || String(song.composer).trim() === '') reasons.push('composer')
      if (!Number(song?.has_embedded_artwork ?? 0)) reasons.push('cover')
      out.push({ path: f.path, songId: f.songId, title: f.title, videoId: f.videoId, reasons })
    }
    return out
  }

  /** Re-resolve and re-embed the metadata of a single file. */
  async fix(path: string): Promise<FixResult> {
    const fail = (reason: string, songId: string | null): FixResult => ({
      ok: false,
      path,
      songId,
      reason
    })
    if (!fs.existsSync(path)) return fail('missing-file', null)
    const song = this.library.getSongByPath(path)
    const fm = this.db.get<{ video_id: string; yt_title: string | null }>(
      'SELECT video_id, yt_title FROM yt_file_meta WHERE path = ?',
      [path]
    )
    const dl = this.db.get<{ url: string; title: string }>(
      'SELECT url, title FROM downloads WHERE dest_path = ? ORDER BY created_at DESC LIMIT 1',
      [path]
    )
    const videoId =
      fm?.video_id ??
      (dl ? ytVideoIdFromUrl(dl.url) : null) ??
      ytVideoIdFromFileName(path)
    const ytTitle = fm?.yt_title ?? dl?.title ?? song?.title ?? ''
    if (!videoId && !ytTitle) return fail('not-a-youtube-download', song?.id ?? null)
    try {
      let track: RichTrackMeta | null = videoId
        ? await this.providers.resolveTrackMeta(
            videoId,
            ytTitle,
            song?.duration ?? null,
            this.providerConfig(),
            true,
            true
          )
        : null
      if (!track) {
        // Text lookup came up empty — try audio fingerprinting (AcoustID).
        track = await this.providers.lookupByFingerprint(
          path,
          song?.duration ?? null,
          this.providerConfig()
        )
      }
      if (!track) return fail('no-match', song?.id ?? null)
      const meta: TrackTagInput = {
        title: track.title,
        channel: null,
        thumbnail: null,
        artist: track.artist || null,
        album: track.album,
        genres: track.genres,
        coverUrl: track.coverUrl,
        composer: track.composer ?? null,
        year: track.year ?? null,
        trackNo: track.trackNo ?? null
      }
      const tagged = await this.providers.tagYouTubeAudioFile(path, videoId ?? '', meta)
      if (!tagged) return fail('tag-failed', song?.id ?? null)
      this.db.run(
        `INSERT INTO yt_file_meta (path, video_id, yt_title, provider, composer_ok, cover_ok, artist_ok, tagged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           video_id = excluded.video_id, yt_title = excluded.yt_title, provider = excluded.provider,
           composer_ok = excluded.composer_ok, cover_ok = excluded.cover_ok,
           artist_ok = excluded.artist_ok, tagged_at = excluded.tagged_at`,
        [
          path,
          videoId ?? '',
          ytTitle,
          track.provider,
          track.composer ? 1 : 0,
          track.coverUrl ? 1 : 0,
          track.artist ? 1 : 0,
          Date.now()
        ]
      )
      if (song) await this.metadataOps.refreshSong(song.id)
      getLogger().info(
        `metadata fix for ${path}: ${track.provider} "${track.title}" — ${track.artist}${
          track.composer ? ` (${track.composer})` : ''
        }`
      )
      return {
        ok: true,
        path,
        songId: song?.id ?? null,
        provider: track.provider,
        title: track.title,
        artist: track.artist,
        composer: track.composer ?? null
      }
    } catch (err) {
      getLogger().warn(`metadata fix failed for ${path}`, err)
      return fail('lookup-error', song?.id ?? null)
    }
  }

  /** Fix files sequentially with pacing; emits progress events. */
  async fixMany(paths: string[]): Promise<{ done: number; failed: number }> {
    if (this.busy) return { done: 0, failed: 0 }
    this.busy = true
    const total = paths.length
    let done = 0
    let failed = 0
    const failures: FixResult[] = []
    this.emit('progress', {
      running: true,
      done,
      total,
      currentPath: null,
      failed,
      failures
    } as FixProgress)
    try {
      for (const path of paths) {
        const last = await this.fix(path)
        if (!last.ok) {
          failed++
          failures.push(last)
        }
        done++
        this.emit('progress', {
          running: done < total,
          done,
          total,
          currentPath: done < total ? (paths[done] ?? null) : null,
          last,
          failed,
          failures
        } as FixProgress)
        if (done < total) await new Promise((r) => setTimeout(r, LOOKUP_GAP_MS))
      }
    } finally {
      this.busy = false
    }
    return { done, failed }
  }

  /** Fix every file that needs attention (composer/cover missing). */
  async fixAll(force = false): Promise<{ done: number; failed: number }> {
    const paths = force
      ? this.youtubeFiles().map((f) => f.path)
      : this.attention().map((a) => a.path)
    if (paths.length === 0) return { done: 0, failed: 0 }
    return this.fixMany(paths)
  }
}
