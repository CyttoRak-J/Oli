import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { getLogger } from './logger'
import type { Database } from './database'
import type { DownloadItem, TrackTagInput } from '@shared/types'
import type { RichTrackMeta } from './provider'

const CONCURRENCY = 3

/** Optional integration points wired by the app container. */
export interface DownloadHooks {
  /** Download a YouTube video (merged audio) via yt-dlp; returns the file path. */
  downloadYouTubeVideo?: (
    videoId: string,
    destDir: string,
    opts: {
      height?: number
      audio?: 'best' | 'm4a' | 'opus'
      onProgress?: (p: number, bytes: number, total: number, speed: number, eta: number) => void
      isAborted?: () => boolean
    }
  ) => Promise<string | null>
  /** Video title for a YouTube id (used for the download row). */
  getYouTubeTitle?: (videoId: string) => Promise<string | null>
  /** Kill a running yt-dlp download immediately (no 500ms poll). */
  forceKillYouTube?: (videoId: string) => void
  /** Wait until no yt-dlp child is running for the video (maxWaitMs cap). */
  whenYtChildGone?: (videoId: string, maxWaitMs: number) => Promise<void>
  /** Whether a yt-dlp child for the video is still alive right now. */
  ytChildRunning?: (videoId: string) => boolean
  /** Download a video's best audio only (used by "Download song"). */
  downloadYouTubeAudioFile?: (
    videoId: string,
    destDir: string,
    opts: {
      audio?: 'best' | 'm4a' | 'opus'
      onProgress?: (p: number, bytes: number, total: number, speed: number, eta: number) => void
      isAborted?: () => boolean
    }
  ) => Promise<string | null>
  /** Embed cover + title/artist/album/genre/composer tags into a downloaded audio file. */
  tagYouTubeAudioFile?: (
    filePath: string,
    videoId: string,
    meta: TrackTagInput | null
  ) => Promise<string | null>
  /** Rich cached metadata (title/channel/thumbnail) for a YouTube id. */
  getYouTubeMeta?: (
    videoId: string
  ) => Promise<{ title: string; channel: string | null; thumbnail: string | null } | null>
  /**
   * Rich music-catalog metadata (Spotify/iTunes) for a song, matched from
   * its YouTube title. Cached per video id; prefetched ahead of downloads.
   * `fresh` bypasses a failed cached attempt (used at tag time, where the
   * full title and the real duration are known).
   */
  resolveTrackMeta?: (videoId: string, title: string, durationSec: number | null, fresh?: boolean) => Promise<RichTrackMeta | null>
  /** Resolve every song of a playlist URL to YouTube {videoId, title} pairs. */
  resolvePlaylistEntries?: (
    url: string
  ) => Promise<{
    entries: Array<{
      videoId: string
      title: string
      duration?: number
      track?: { name: string; artists: string[]; album: string | null; durationMs: number | null }
    }>
    error?: string
    capped?: boolean
  }>
}

/** In-memory params for yt-dlp download jobs (lost on restart, like the queue). */
interface YtJob {
  videoId: string
  height: number
  audio: 'best' | 'm4a' | 'opus'
  /** Custom folder chosen by the user (defaults to the app downloads dir). */
  destDir?: string
  /** 'video' = merged MP4, 'song' = audio-only file + embedded tags/cover. */
  mode: 'video' | 'song'
  /** Video duration in seconds (when known from the playlist listing). */
  duration?: number
  /** Exact source track metadata (Spotify playlists); skips the meta lookup. */
  track?: { name: string; artists: string[]; album: string | null; durationMs: number | null }
}

/**
 * Authorized download manager.
 *
 * Downloads are strictly limited to content the user is permitted to download
 * (their own files, DRM-free sources, or services that explicitly allow it).
 * Supports concurrent queue processing, pause/resume via HTTP Range, retry,
 * cancellation, progress/speed/ETA reporting and size verification.
 * YouTube URLs are routed through yt-dlp so the result is a single file with
 * both video and audio (merged with ffmpeg when available), with live
 * progress reported to the same Downloads list.
 */
export class DownloadService extends EventEmitter {
  private active = 0
  private processing = false
  private aborted = new Set<string>()
  private ytJobs = new Map<string, YtJob>()
  /** Count of currently running yt-dlp downloads (YouTube runs one at a time). */
  private activeYt = 0
  /** Guard so only one prefetch sweep runs at a time. */
  private prefetchRunning = false
  /**
   * Monotonic creation timestamp: enqueueing many rows in the same
   * millisecond (playlists) otherwise leaves created_at tied, making the
   * queue order arbitrary. Each row gets a strictly larger value.
   */
  private lastCreatedAt = 0
  /** In-flight HTTP download file streams, so abort/remove can tear them down. */
  private activeFiles = new Map<string, fs.WriteStream>()

  constructor(
    private db: Database,
    private downloadsDir: string,
    private hooks: DownloadHooks = {},
    private opts: { songsAhead?: () => number; ytConcurrency?: () => number } = {}
  ) {
    super()
  }

  list(): DownloadItem[] {
    return this.db
      .all<Record<string, unknown>>(
        'SELECT * FROM downloads ORDER BY created_at DESC, updated_at DESC'
      )
      .map(toItem)
  }

  /**
   * Resume after a crash / app restart: re-queue any downloads that were
   * mid-flight (state 'downloading' or 'queued'). YouTube rows restart their
   * yt-dlp job, which continues the existing .part file from where it left
   * off; plain HTTP rows re-use their byte count and resume via HTTP Range.
   * Rows the user deliberately paused are left untouched.
   */
  start(): Promise<void> {
    // A previous session may have left orphaned yt-dlp processes running
    // (killing the app does not kill its children on Windows). Drop them
    // BEFORE starting any job — and wait until the kill actually lands, so
    // a fresh yt-dlp process can never be killed by its own cleanup.
    const killOrphans = (): Promise<void> =>
      new Promise<void>((resolve) => {
        try {
          const kill = spawn('taskkill', ['/F', '/IM', 'yt-dlp.exe'], { windowsHide: true })
          kill.on('close', () => resolve())
          kill.on('error', () => resolve())
          setTimeout(resolve, 5000)
        } catch {
          resolve()
        }
      })
    const rows = this.db.all<{ id: string; url: string; dest_path: string; kind: string }>(
      "SELECT id, url, dest_path, kind FROM downloads WHERE state IN ('downloading', 'queued')"
    )
    let resumed = 0
    for (const row of rows) {
      const ytId = ytVideoIdFromUrl(row.url)
      if (ytId && this.hooks.downloadYouTubeVideo) {
        this.ytJobs.set(row.id, {
          videoId: ytId,
          height: 0,
          audio: 'best',
          destDir: row.dest_path ? path.dirname(row.dest_path) : undefined,
          mode: row.kind === 'song' ? 'song' : 'video'
        })
      }
      this.db.run(
        "UPDATE downloads SET state = 'queued', speed = 0, updated_at = ? WHERE id = ?",
        [Date.now(), row.id]
      )
      resumed++
    }
    const orphanSweep = (): void => {
      // Leftover .part / .ytdl / .temp files whose download rows no longer
      // exist belong to crashed sessions: delete them so they don't pile up
      // on disk (the matching yt-dlp processes were killed above).
      try {
        const knownYtIds = new Set<string>()
        for (const row of this.db.all<{ url: string }>('SELECT url FROM downloads')) {
          const ytId = ytVideoIdFromUrl(row.url)
          if (ytId) knownYtIds.add(ytId)
        }
        for (const name of fs.readdirSync(this.downloadsDir)) {
          const m = /\[([\w-]{11})\]\.(?:[\w.]+\.(?:part|ytdl|temp)|info\.json|part|ytdl|temp)$/.exec(name)
          if (!m) continue
          if (knownYtIds.has(m[1])) continue
          try {
            fs.rmSync(path.join(this.downloadsDir, name), { force: true })
            getLogger().info(`Deleted orphan download file ${name}`)
          } catch {
            // leave it; it will be retried on the next boot
          }
        }
      } catch {
        // ignore scan errors
      }
    }
    return killOrphans().then(() => {
      orphanSweep()
      if (resumed === 0) return
      getLogger().info('Resuming interrupted downloads', String(resumed))
      this.emit('changed')
      void this.pump()
    })
  }

  async enqueue(url: string, title = 'download'): Promise<DownloadItem | null> {
    const parsed = safeUrl(url)
    if (!parsed) {
      getLogger().warn('Rejected invalid download URL', url)
      return null
    }
    // Title fallbacks, most useful first: the user's own, the real video
    // title for YouTube links (same as the video window's Download button),
    // or the file name from the URL.
    const userTitle = title.trim()
    let resolvedTitle = userTitle
    const ytId = ytVideoIdFromUrl(url)
    if (!resolvedTitle) {
      if (ytId) resolvedTitle = (await this.hooks.getYouTubeTitle?.(ytId)) ?? 'YouTube video'
      else
        resolvedTitle =
          path
            .basename(parsed.pathname)
            .replace(/\.[a-z0-9]{1,5}$/i, '')
            .trim() || 'download'
    }
    const id = randomUUID()
    const safeName = sanitizeFilename(resolvedTitle)
    const ext = extFromUrl(parsed)
    // Two downloads can resolve to the same destination (same title, retries):
    // concurrent writes would truncate each other's file, so a busy path gets
    // a " (2)" suffix instead.
    let destPath = path.join(this.downloadsDir, `${safeName}${ext}`)
    let n = 2
    while (this.db.get('SELECT id FROM downloads WHERE dest_path = ?', [destPath])) {
      destPath = path.join(this.downloadsDir, `${safeName} (${n++})${ext}`)
    }
    const now = Date.now()
    this.db.run(
      `INSERT INTO downloads (id, title, url, dest_path, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
      [id, resolvedTitle, url, destPath, now, now]
    )
    this.emit('changed')
    void this.pump()
    return this.getItem(id)
  }

  pause(id: string): void {
    this.aborted.add(id)
    this.killStream(id)
    const ytJob = this.ytJobs.get(id)
    if (ytJob) this.hooks.forceKillYouTube?.(ytJob.videoId)
    this.db.run("UPDATE downloads SET state = 'paused', speed = 0, updated_at = ? WHERE id = ?", [
      Date.now(),
      id
    ])
    this.emit('changed')
  }

  /** Pause every active (downloading or queued) download. */
  pauseAll(): number {
    const rows = this.db.all<{ id: string }>(
      "SELECT id FROM downloads WHERE state IN ('downloading', 'queued')"
    )
    for (const row of rows) {
      this.aborted.add(row.id)
      this.killStream(row.id)
      const ytJob = this.ytJobs.get(row.id)
      if (ytJob) this.hooks.forceKillYouTube?.(ytJob.videoId)
      this.db.run("UPDATE downloads SET state = 'paused', speed = 0, updated_at = ? WHERE id = ?", [
        Date.now(),
        row.id
      ])
    }
    if (rows.length > 0) this.emit('changed')
    return rows.length
  }

  /** Resume every paused download. */
  resumeAll(): number {
    const rows = this.db.all<{ id: string }>("SELECT id FROM downloads WHERE state = 'paused'")
    for (const row of rows) {
      this.aborted.delete(row.id)
      this.db.run("UPDATE downloads SET state = 'queued', updated_at = ? WHERE id = ?", [
        Date.now(),
        row.id
      ])
    }
    if (rows.length > 0) {
      this.emit('changed')
      void this.pump()
    }
    return rows.length
  }

  /** Remove a row from the list entirely (aborting it first if active). */
  remove(id: string, deleteFile = false): void {
    const fileRow = deleteFile
      ? this.db.get<{ dest_path: string; url: string }>(
          'SELECT dest_path, url FROM downloads WHERE id = ?',
          [id]
        )
      : null
    const ytId = fileRow?.url?.match(
      /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/))([\w-]{11})/
    )?.[1]
    this.aborted.add(id)
    this.ytJobs.delete(id)
    this.killStream(id)
    // Kill the yt-dlp child NOW (the abort poll below would take up to 500ms,
    // and Windows refuses deletion while the process keeps the file open).
    if (ytId) this.hooks.forceKillYouTube?.(ytId)
    if (deleteFile) {
      const dir = fileRow?.dest_path
        ? path.dirname(fileRow.dest_path)
        : ytId
          ? this.downloadsDir
          : null
      if (ytId && this.hooks.whenYtChildGone) {
        // Deleting a file while yt-dlp still holds it open makes Windows
        // security tooling terminate the app outright (silent, no WER, no
        // dump). So NEVER touch the files until the child has actually
        // exited; if it refuses to die, kill it via an external taskkill
        // (proven survivable) and only then delete.
        const delAfterGone = async (): Promise<void> => {
          await this.hooks.whenYtChildGone?.(ytId, 15_000)
          if (this.hooks.ytChildRunning?.(ytId)) {
            await this.killYtExternally()
            await this.hooks.whenYtChildGone?.(ytId, 8_000)
          }
          if (this.hooks.ytChildRunning?.(ytId)) {
            getLogger().warn('yt-dlp would not exit; leaving download file in place')
            return
          }
          this.retryDelete(fileRow?.dest_path ?? null, ytId, dir, true)
        }
        void delAfterGone()
      } else {
        this.retryDelete(fileRow?.dest_path ?? null, ytId ?? null, dir, false)
      }
    }
    this.db.run('DELETE FROM downloads WHERE id = ?', [id])
    this.emit('changed')
  }

  /** Kill stray yt-dlp processes via an external taskkill (safe, survivable). */
  private killYtExternally(): Promise<void> {
    return new Promise<void>((resolve) => {
      try {
        const kill = spawn('taskkill', ['/F', '/IM', 'yt-dlp.exe'], { windowsHide: true })
        kill.on('close', () => resolve())
        kill.on('error', () => resolve())
        setTimeout(resolve, 4000)
      } catch {
        resolve()
      }
    })
  }

  /**
   * Best-effort background file deletion, strictly NEVER against a file that
   * a live downloader may still hold open (Windows security tooling kills
   * the app outright in that case). When `peaceful` (yt-dlp path) the child
   * is already confirmed dead, so two short passes suffice; ffmpeg may still
   * be finishing the merge, so one late repass covers it.
   */
  private retryDelete(
    destPath: string | null,
    ytId: string | null,
    dir: string | null,
    peaceful = false
  ): void {
    const attempts = peaceful ? [400, 6000] : [300, 600, 1200, 2500, 5000]
    const attempt = (i: number): void => {
      if (i >= attempts.length) {
        getLogger().warn('Could not delete download file', destPath ?? dir ?? 'unknown')
        return
      }
      let ok = false
      let lastErr: string | null = null
      try {
        if (destPath && fs.existsSync(destPath)) {
          fs.rmSync(destPath, { force: true })
          ok = !fs.existsSync(destPath)
        } else if (dir) {
          const base = destPath ? path.basename(destPath) : ''
          const leftovers = fs
            .readdirSync(dir)
            .filter(
              (name) => (ytId != null && name.includes(ytId)) || (base && name.startsWith(base))
            )
          for (const name of leftovers) fs.rmSync(path.join(dir, name), { force: true })
          ok = true
        } else {
          ok = true
        }
      } catch (err) {
        ok = false
        lastErr = (err as NodeJS.ErrnoException).code ?? (err as Error).message
      }
      getLogger().debug(`retryDelete attempt ${i} ok=${ok} err=${lastErr ?? '-'}`, String(destPath))
      if (!ok) {
        const delay =
          attempts[i + 1] != null ? attempts[i + 1] - attempts[i] : 10000
        setTimeout(() => attempt(i + 1), delay)
      }
    }
    // Defer the very first attempt out of the synchronous remove() call so no
    // fs work runs while the yt-dlp child is being torn down.
    setTimeout(() => attempt(0), 300)
  }

  /**
   * Queue a YouTube video download (via yt-dlp, merged audio). The row
   * appears in the Downloads list with live progress; `destDir` may be a
   * folder picked by the user (defaults to the app downloads folder).
   */
  async enqueueYouTubeVideo(
    videoId: string,
    title: string,
    opts: { height?: number; audio?: 'best' | 'm4a' | 'opus'; destDir?: string } = {}
  ): Promise<DownloadItem | null> {
    if (!videoId) return null
    if (!this.hooks.downloadYouTubeVideo) {
      getLogger().warn('enqueueYouTubeVideo: downloadYouTubeVideo hook not available')
      return null
    }
    // One active download per video: repeated clicks on the video window's
    // Download button must not spawn duplicate yt-dlp processes.
    for (const [jobId, existing] of this.ytJobs.entries()) {
      if (existing.videoId === videoId) {
        const row = this.getItem(jobId)
        if (row && (row.state === 'queued' || row.state === 'downloading')) return row
      }
    }
    const destDir = opts.destDir && opts.destDir.trim() ? opts.destDir.trim() : this.downloadsDir
    const id = randomUUID()
    const now = Math.max(Date.now(), this.lastCreatedAt + 1)
    this.lastCreatedAt = now
    this.db.run(
      `INSERT INTO downloads (id, title, url, dest_path, state, kind, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', 'video', ?, ?)`,
      [
        id,
        title.slice(0, 200),
        `https://www.youtube.com/watch?v=${videoId}`,
        path.join(destDir, `${sanitizeFilename(title)}.mp4`),
        now,
        now
      ]
    )
    this.ytJobs.set(id, {
      videoId,
      height: opts.height ?? 0,
      audio: opts.audio ?? 'best',
      destDir: destDir === this.downloadsDir ? undefined : destDir,
      mode: 'video'
    })
    this.emit('changed')
    void this.pump()
    return this.getItem(id)
  }

  /**
   * Queue a YouTube SONG download: the video's best audio as a single file,
   * then embedded with cover art + title/artist/album tags. Same live
   * progress and Downloads-page row as video downloads.
   */
  async enqueueYouTubeSong(
    videoId: string,
    title: string,
    opts: {
      audio?: 'best' | 'm4a' | 'opus'
      destDir?: string
      duration?: number
      track?: { name: string; artists: string[]; album: string | null; durationMs: number | null }
    } = {}
  ): Promise<DownloadItem | null> {
    if (!videoId) return null
    if (!this.hooks.downloadYouTubeAudioFile) {
      getLogger().warn('enqueueYouTubeSong: downloadYouTubeAudioFile hook not available')
      return null
    }
    for (const [jobId, existing] of this.ytJobs.entries()) {
      if (existing.videoId === videoId) {
        const row = this.getItem(jobId)
        if (row && (row.state === 'queued' || row.state === 'downloading')) return row
      }
    }
    const destDir = opts.destDir && opts.destDir.trim() ? opts.destDir.trim() : this.downloadsDir
    const id = randomUUID()
    const now = Math.max(Date.now(), this.lastCreatedAt + 1)
    this.lastCreatedAt = now
    this.db.run(
      `INSERT INTO downloads (id, title, url, dest_path, state, kind, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', 'song', ?, ?)`,
      [
        id,
        title.slice(0, 200),
        `https://www.youtube.com/watch?v=${videoId}`,
        path.join(destDir, `${sanitizeFilename(title)}.${opts.audio === 'opus' ? 'opus' : 'm4a'}`),
        now,
        now
      ]
    )
    this.ytJobs.set(id, {
      videoId,
      height: 0,
      audio: opts.audio ?? 'best',
      destDir: destDir === this.downloadsDir ? undefined : destDir,
      mode: 'song',
      duration: opts.duration,
      track: opts.track
    })
    this.emit('changed')
    void this.pump()
    return this.getItem(id)
  }

  /**
   * Enqueue every song of a playlist (YouTube or Spotify URL). Each song
   * becomes a tagged audio download row; the queue downloads them one by one.
   */
  async enqueuePlaylist(
    url: string,
    opts: { audio?: 'best' | 'm4a' | 'opus'; destDir?: string } = {}
  ): Promise<{ found: number; enqueued: number; error?: string; capped?: boolean }> {
    const resolved = (await this.hooks.resolvePlaylistEntries?.(url)) ?? { entries: [] }
    if (resolved.error) return { found: 0, enqueued: 0, error: resolved.error }
    const active = new Set<string>()
    for (const [, job] of this.ytJobs.entries()) active.add(job.videoId)
    let enqueued = 0
    for (const entry of resolved.entries) {
      if (active.has(entry.videoId)) continue
      const row = await this.enqueueYouTubeSong(entry.videoId, entry.title, {
        ...opts,
        duration: entry.duration,
        track: entry.track
      })
      if (row) {
        active.add(entry.videoId)
        enqueued++
      }
    }
    return { found: resolved.entries.length, enqueued, capped: resolved.capped === true }
  }

  /**
   * Swap in a resolved title (the enqueue happens instantly with a
   * placeholder, then the real title lands here once YouTube answers).
   */
  updateTitle(id: string, title: string): void {    const clean = title.trim().slice(0, 200)
    if (!clean) return
    const cur = this.db.get<{ title: string }>('SELECT title FROM downloads WHERE id = ?', [id])
    if (!cur || cur.title === clean) return
    this.db.run('UPDATE downloads SET title = ?, updated_at = ? WHERE id = ?', [
      clean,
      Date.now(),
      id
    ])
    this.emit('changed')
  }

  resume(id: string): void {
    const item = this.getItem(id)
    if (!item || item.state === 'completed' || item.state === 'downloading') return
    this.aborted.delete(id)
    this.db.run("UPDATE downloads SET state = 'queued', updated_at = ? WHERE id = ?", [
      Date.now(),
      id
    ])
    this.emit('changed')
    void this.pump()
  }

  cancel(id: string): void {
    this.aborted.add(id)
    this.killStream(id)
    const ytJob = this.ytJobs.get(id)
    if (ytJob) this.hooks.forceKillYouTube?.(ytJob.videoId)
    this.db.run("UPDATE downloads SET state = 'canceled', speed = 0, updated_at = ? WHERE id = ?", [
      Date.now(),
      id
    ])
    const item = this.getItem(id)
    try {
      if (item?.destPath && fs.existsSync(item.destPath)) fs.unlinkSync(item.destPath)
    } catch {
      // ignore
    }
    this.emit('changed')
  }

  retry(id: string): void {
    this.aborted.delete(id)
    this.db.run(
      "UPDATE downloads SET state = 'queued', error = NULL, progress = 0, downloaded_bytes = 0, updated_at = ? WHERE id = ?",
      [Date.now(), id]
    )
    this.emit('changed')
    void this.pump()
  }

  clearCompleted(): void {
    this.db.run("DELETE FROM downloads WHERE state IN ('completed', 'canceled', 'failed')")
    this.emit('changed')
  }

  /**
   * Cancel and remove every download that has not finished (queued /
   * downloading / paused) — no file was saved for these, so nothing on disk
   * is touched.
   */
  clearPending(): number {
    const rows = this.db.all<{ id: string }>(
      "SELECT id FROM downloads WHERE state IN ('queued', 'downloading', 'paused')"
    )
    for (const row of rows) this.remove(row.id, false)
    if (rows.length > 0) this.emit('changed')
    return rows.length
  }

  getItem(id: string): DownloadItem | null {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM downloads WHERE id = ?', [id])
    return row ? toItem(row) : null
  }

  /** Destroy an in-flight HTTP write stream (idempotent; safe on any state). */
  private killStream(id: string): void {
    const f = this.activeFiles.get(id)
    if (f && !f.destroyed) {
      try {
        f.destroy()
      } catch {
        // already gone
      }
    }
    this.activeFiles.delete(id)
  }

  private async pump(): Promise<void> {
    if (this.processing) return
    this.processing = true
    try {
      while (this.active < CONCURRENCY) {
        // Pick the oldest queued job that can run now: when the YouTube slot
        // is full, HTTP jobs behind a YT row must not starve (a `break` here
        // would stop the whole pump).
        const ytLimit = Math.max(1, Math.min(3, this.opts.ytConcurrency?.() ?? 1))
        const queued = this.db.all<{ id: string }>(
          "SELECT id FROM downloads WHERE state = 'queued' ORDER BY created_at ASC"
        )
        const next = queued.find((r) => {
          if (!this.isYtJob(r.id)) return true
          return this.activeYt < ytLimit
        })
        if (!next) break
        const isYt = this.isYtJob(next.id)
        this.active++
        if (isYt) this.activeYt++
        void this.process(next.id).finally(() => {
          this.active--
          if (isYt) this.activeYt--
          void this.pump()
        })
      }
      // Runs on every pump (not only when a job starts), so metadata for the
      // next songs resolves while the current one is still downloading.
      void this.prefetchAhead()
    } finally {
      this.processing = false
    }
  }

  /**
   * Prepare music-catalog metadata (Spotify/iTunes) for the next queued
   * songs while the current one downloads. The lookup is cached by video id,
   * so when a song reaches the downloading phase its tags + cover are ready
   * instantly. Depth = "songs ahead" setting minus the one downloading.
   */
  private prefetchAhead(): void {
    if (this.prefetchRunning) return
    this.prefetchRunning = true
    const depth = Math.max(0, Math.min(5, (this.opts.songsAhead?.() ?? 3) - 1))
    if (depth === 0 || !this.hooks.resolveTrackMeta) {
      this.prefetchRunning = false
      return
    }
    void (async () => {
      try {
        const rows = this.db.all<{ id: string; title: string; url: string }>(
          "SELECT id, title, url FROM downloads WHERE state = 'queued' ORDER BY created_at ASC LIMIT ?",
          [depth]
        )
        for (const row of rows) {
          const job = this.ytJobs.get(row.id)
          const videoId = job?.videoId ?? ytVideoIdFromUrl(row.url)
          if (!videoId || job?.track) continue
          // Placeholder rows (single-song enqueues) have no usable title yet;
          // those resolve their metadata at tag time instead.
          if (!row.title || /^YouTube (song|video)$/i.test(row.title)) continue
          void this.hooks.resolveTrackMeta?.(videoId, row.title, job?.duration ?? null)
        }
      } finally {
        this.prefetchRunning = false
      }
    })()
  }

  private isYtJob(id: string): boolean {
    if (this.ytJobs.has(id)) return true
    const row = this.db.get<{ url: string }>('SELECT url FROM downloads WHERE id = ?', [id])
    return row != null && ytVideoIdFromUrl(row.url) != null
  }

  private async process(id: string): Promise<void> {
    const item = this.getItem(id)
    if (!item) return
    // YouTube videos download through yt-dlp (merged audio, live progress);
    // plain HTTP fetch would save the HTML page or an audio-less stream.
    const job = this.ytJobs.get(id)
    if (job) {
      try {
        await this.downloadWithYtDlp(id, job)
      } finally {
        // The HTTP path clears the abort flag below; the YT path must too,
        // or a paused-then-retried download dies instantly (it checks the
        // flag but nothing ever removes it).
        this.aborted.delete(id)
      }
      return
    }
    const ytId = ytVideoIdFromUrl(item.url)
    if (ytId && this.hooks.downloadYouTubeVideo) {
      this.ytJobs.set(id, { videoId: ytId, height: 0, audio: 'best', mode: 'video' })
      try {
        await this.downloadWithYtDlp(id, this.ytJobs.get(id)!)
      } finally {
        this.aborted.delete(id)
      }
      return
    }
    const url = safeUrl(item.url)
    if (!url) {
      this.fail(id, 'Invalid URL')
      return
    }
    const destPath = item.destPath || path.join(this.downloadsDir, sanitizeFilename(item.title))
    const startedAt = Date.now()
    const startedBytes =
      item.downloadedBytes > 0 && fs.existsSync(destPath) ? item.downloadedBytes : 0

    let file: fs.WriteStream | null = null
    try {
      fs.mkdirSync(path.dirname(destPath), { recursive: true })
      const headers: Record<string, string> = {}
      if (startedBytes > 0) headers.Range = `bytes=${startedBytes}-`
      const res = await fetch(url, { headers, redirect: 'follow' })
      if (this.aborted.has(id)) {
        this.markStopped(item)
        return
      }
      if (!res.ok) {
        this.fail(id, `HTTP ${res.status} ${res.statusText}`)
        return
      }
      const isRange = res.status === 206
      const knownStart = isRange && startedBytes > 0 ? startedBytes : 0
      const contentLength = parseContentLength(res.headers.get('content-length'))
      const resolvedTotal = contentLength != null ? knownStart + contentLength : null

      this.db.run(
        'UPDATE downloads SET state = ?, total_bytes = ?, updated_at = ? WHERE id = ?',
        ['downloading', resolvedTotal ?? item.totalBytes, Date.now(), id]
      )
      this.emit('changed')

      file = fs.createWriteStream(destPath, { flags: knownStart > 0 ? 'a' : 'w' })
      this.activeFiles.set(id, file)
      // Stream errors (e.g. a write landing after teardown) must never turn
      // into an uncaught exception; state is handled via the abort checks.
      file.on('error', () => {
        /* swallowed */
      })
      const nodeStream = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
      let received = knownStart
      let lastEmit = Date.now()

      nodeStream.on('data', (chunk: Buffer) => {
        if (this.aborted.has(id) || !file || file.destroyed) {
          nodeStream.destroy()
          return
        }
        received += chunk.length
        const now = Date.now()
        if (now - lastEmit >= 500) {
          lastEmit = now
          const elapsedSec = Math.max(1, (now - startedAt) / 1000)
          const speed = (received - knownStart) / elapsedSec
          const remaining = resolvedTotal != null ? resolvedTotal - received : 0
          const progress = resolvedTotal != null && resolvedTotal > 0 ? received / resolvedTotal : 0
          this.db.run(
            `UPDATE downloads SET downloaded_bytes = ?, progress = ?, speed = ?, eta_seconds = ?, updated_at = ? WHERE id = ?`,
            [
              received,
              progress,
              Math.round(speed),
              speed > 0 && remaining > 0 ? Math.round(remaining / speed) : null,
              now,
              id
            ]
          )
          this.emit('changed')
        }
      })
      nodeStream.on('error', () => {
        /* handled by finished() */
      })
      nodeStream.pipe(file)
      await finished(nodeStream)

      if (this.aborted.has(id)) {
        this.markStopped(item)
        return
      }
      if (resolvedTotal != null && received !== resolvedTotal) {
        this.fail(id, `Incomplete download (${received}/${resolvedTotal})`)
        return
      }
      this.db.run(
        `UPDATE downloads SET downloaded_bytes = ?, progress = 1, speed = 0, eta_seconds = NULL, state = 'completed', error = NULL, updated_at = ? WHERE id = ?`,
        [received, Date.now(), id]
      )
      this.emit('changed')
    } catch (err) {
      if (this.aborted.has(id)) {
        this.markStopped(item)
        return
      }
      this.fail(id, (err as Error).message || 'Download failed')
    } finally {
      this.activeFiles.delete(id)
      if (file && !file.destroyed) file.destroy()
      this.aborted.delete(id)
    }
  }

  /** Download a YouTube video via yt-dlp (merged audio), reporting live progress. */
  private async downloadWithYtDlp(id: string, job: YtJob): Promise<void> {
    const item = this.getItem(id)
    if (!item) return
    this.db.run("UPDATE downloads SET state = 'downloading', updated_at = ? WHERE id = ?", [
      Date.now(),
      id
    ])
    this.emit('changed')
    const base = job.destDir && job.destDir.trim() ? job.destDir.trim() : this.downloadsDir
    const onProgress = (p: number, bytes: number, total: number, speed: number, eta: number): void => {
      const effSpeed = Math.max(0, Math.round(speed))
      const effEta =
        eta > 0
          ? eta
          : effSpeed > 0 && total > bytes
            ? Math.round((total - bytes) / effSpeed)
            : null
      this.db.run(
        `UPDATE downloads SET downloaded_bytes = ?, total_bytes = ?, progress = ?, speed = ?, eta_seconds = ?, updated_at = ? WHERE id = ?`,
        [
          bytes,
          total > 0 ? total : null,
          Math.min(1, Math.max(0, p / 100)),
          effSpeed,
          effEta,
          Date.now(),
          id
        ]
      )
      this.emit('changed')
    }
    try {
      // Download straight into the target folder: the file yt-dlp produces
      // IS the final download (no temp staging, no copies). Song downloads
      // use the audio-only hook and then get tags + cover embedded.
      const dest =
        job.mode === 'song' && this.hooks.downloadYouTubeAudioFile
          ? await this.hooks.downloadYouTubeAudioFile(job.videoId, base, {
              audio: job.audio,
              onProgress,
              isAborted: () => this.aborted.has(id)
            })
          : await this.hooks.downloadYouTubeVideo?.(job.videoId, base, {
              height: job.height,
              audio: job.audio,
              onProgress,
              isAborted: () => this.aborted.has(id)
            })
      if (this.aborted.has(id)) {
        this.markStopped(item)
        return
      }
      if (!dest || !fs.existsSync(dest)) {
        this.fail(id, 'YouTube download failed')
        return
      }
      let finalDest = dest
      if (job.mode === 'song' && this.hooks.tagYouTubeAudioFile) {
        // getYouTubeMeta is a fresh yt-dlp call per song and can fail under
        // YouTube's bot checks; the stored row title keeps the lookup going.
        const ytMeta = (await this.hooks.getYouTubeMeta?.(job.videoId).catch(() => null)) ?? null
        let meta: {
          title: string
          channel: string | null
          thumbnail: string | null
          artist?: string | null
          album?: string | null
          genres?: string[]
          coverUrl?: string | null
          composer?: string | null
          year?: number | null
          trackNo?: number | null
        } | null = {
          title: ytMeta?.title ?? item.title,
          channel: ytMeta?.channel ?? null,
          thumbnail: ytMeta?.thumbnail ?? null
        }
        const rawYtTitle = meta.title
        let tagProvider: string | null = null
        if (job.track) {
          // Spotify playlist source: exact metadata, no lookup needed.
          meta = {
            ...meta,
            title: job.track.name,
            artist: job.track.artists.join(', '),
            album: job.track.album,
            genres: []
          }
        } else {
          // Prefetched (cached) lookup — instant when the pipeline ran.
          // `fresh`: prefetch used the truncated playlist title and had no
          // duration, so the tag-time attempt must not reuse a failed one.
          const track = await this.hooks.resolveTrackMeta?.(
            job.videoId,
            meta.title,
            job.duration ?? null,
            true
          )
          if (track) {
            meta = {
              ...meta,
              title: track.title || meta.title,
              artist: track.artist || null,
              album: track.album,
              genres: track.genres,
              coverUrl: track.coverUrl,
              composer: track.composer,
              year: track.year ?? null,
              trackNo: track.trackNo ?? null
            }
            tagProvider = track.provider
          }
        }
        finalDest =
          (await this.hooks.tagYouTubeAudioFile(dest, job.videoId, meta)) ?? dest
        // Remember how this file's metadata was resolved, so the "fix
        // metadata" feature knows the source and whether fields are missing.
        this.db.run(
          `INSERT INTO yt_file_meta (path, video_id, yt_title, provider, composer_ok, cover_ok, artist_ok, tagged_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET
             video_id = excluded.video_id, yt_title = excluded.yt_title, provider = excluded.provider,
             composer_ok = excluded.composer_ok, cover_ok = excluded.cover_ok,
             artist_ok = excluded.artist_ok, tagged_at = excluded.tagged_at`,
          [
            finalDest,
            job.videoId,
            rawYtTitle,
            tagProvider,
            meta.composer ? 1 : 0,
            meta.coverUrl || meta.thumbnail ? 1 : 0,
            meta.artist ? 1 : 0,
            Date.now()
          ]
        )
      }
      const size = fs.statSync(finalDest).size
      this.db.run(
        `UPDATE downloads SET dest_path = ?, downloaded_bytes = ?, total_bytes = ?, progress = 1, speed = 0, eta_seconds = NULL, state = 'completed', error = NULL, updated_at = ? WHERE id = ?`,
        [finalDest, size, size, Date.now(), id]
      )
      this.ytJobs.delete(id)
      this.emit('changed')
    } catch (err) {
      this.fail(id, (err as Error).message || 'YouTube download failed')
    }
  }

  private markStopped(item: DownloadItem | null): void {
    if (!item) return
    // Preserve 'paused' if the user paused the row while this task was
    // tearing down (item snapshot may predate the pause).
    const current = this.db.get<{ state: string }>('SELECT state FROM downloads WHERE id = ?', [
      item.id
    ])
    const state = current && current.state === 'paused' ? 'paused' : 'canceled'
    this.db.run('UPDATE downloads SET state = ?, updated_at = ? WHERE id = ?', [
      state,
      Date.now(),
      item.id
    ])
    this.emit('changed')
  }

  private fail(id: string, error: string): void {
    this.db.run("UPDATE downloads SET state = 'failed', error = ?, updated_at = ? WHERE id = ?", [
      error,
      Date.now(),
      id
    ])
    try {
      this.db.run(
        'INSERT INTO failed_downloads (id, url, error, failed_at) SELECT ?, id, ?, ? FROM downloads WHERE id = ?',
        [randomUUID(), error, Date.now(), id]
      )
    } catch {
      // ignore
    }
    this.emit('changed')
  }

  reveal(id: string): string | null {
    const item = this.getItem(id)
    if (!item?.destPath || !fs.existsSync(item.destPath)) return null
    return item.destPath
  }

  get directory(): string {
    return this.downloadsDir
  }
}

function toItem(row: Record<string, unknown>): DownloadItem {
  return {
    id: String(row.id),
    title: String(row.title ?? ''),
    url: String(row.url ?? ''),
    destPath: String(row.dest_path ?? ''),
    state: (row.state as DownloadItem['state']) ?? 'failed',
    progress: Number(row.progress ?? 0),
    totalBytes: row.total_bytes != null ? Number(row.total_bytes) : null,
    downloadedBytes: Number(row.downloaded_bytes ?? 0),
    speed: Number(row.speed ?? 0),
    etaSeconds: row.eta_seconds != null ? Number(row.eta_seconds) : null,
    error: row.error ? String(row.error) : null,
    missing:
      row.state === 'completed' && Boolean(row.dest_path) && !fs.existsSync(String(row.dest_path)),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0)
  }
}

function safeUrl(url: string): URL | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed
    return null
  } catch {
    return null
  }
}

/** Extract a YouTube video id from watch / youtu.be / shorts / embed URLs. */
export function ytVideoIdFromUrl(raw: string): string | null {
  try {
    const u = new URL(raw)
    if (u.hostname === 'youtu.be') {
      const id = u.pathname.slice(1).split('/')[0]
      return id ? id.slice(0, 11) : null
    }
    if (/^(www\.|m\.)?youtube\.com$/i.test(u.hostname)) {
      if (u.pathname === '/watch') return u.searchParams.get('v')?.slice(0, 11) ?? null
      const m = /^\/(?:shorts|embed)\/([^/]+)/i.exec(u.pathname)
      return m ? m[1].slice(0, 11) : null
    }
  } catch {
    // ignore
  }
  return null
}

function parseContentLength(value: string | null): number | null {
  if (!value) return null
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function sanitizeFilename(input: string): string {
  return input
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\p{C}/gu, '_')
    .trim()
    .slice(0, 120) || 'download'
}

function extFromUrl(url: URL): string {
  const m = /\.([a-z0-9]{1,5})$/i.exec(url.pathname)
  return m ? `.${m[1].toLowerCase()}` : '.bin'
}