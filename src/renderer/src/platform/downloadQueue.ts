/**
 * The phone's download list: what is queued / running / paused / finished / failed, kept across restarts. The transfers
 * themselves are done by the native `OliDownload` plugin (a foreground service, resumable, MD5 and size checked, tags
 * and cover written into the file); this class keeps the list, maps the plugin's events onto the same `DownloadItem`
 * rows the Downloads screen shows on the PC, and turns a finished file into a song through `onCompleted`.
 *
 * Only the plugin interface and a small store are used, so it is unit-tested with fakes.
 */
import type { DownloadItem } from '@shared/types'

export interface DownloadTags {
  title?: string
  artist?: string
  albumArtist?: string
  album?: string
  genre?: string
  composer?: string
  isrc?: string
  lyrics?: string
  trackNo?: number
  discNo?: number
  year?: number
}

/** Everything needed to (re)start a download and to make a song out of it afterwards. */
export interface DownloadJob {
  url: string
  /** Path below the app's download folder, e.g. "Oli/Album/01 Song.flac". */
  relPath: string
  size: number
  md5: string
  coverUrl?: string
  tags?: DownloadTags
  headers?: Record<string, string>
  /** Opaque data for the caller (which archive item / file this is). */
  meta?: unknown
}

export interface DownloadEnqueue {
  title: string
  job: DownloadJob
}

interface ListenerHandle {
  remove(): Promise<void> | void
}

export interface OliDownloadPlugin {
  getRoot(): Promise<{ root: string }>
  enqueue(o: {
    id: string
    url: string
    relPath: string
    size?: number
    md5?: string
    coverUrl?: string
    tags?: DownloadTags
    headers?: Record<string, string>
  }): Promise<void>
  pause(o: { id: string }): Promise<void>
  resume(o: { id: string }): Promise<void>
  cancel(o: { id: string; relPath?: string }): Promise<void>
  getActive(): Promise<{ ids: string[] }>
  /** Writes tags into a FLAC / MP3 file in the app's own folder. */
  writeTags(o: { path: string; tags: DownloadTags }): Promise<{ written: boolean; note: string }>
  addListener(event: string, cb: (data: never) => void): Promise<ListenerHandle> | ListenerHandle
}

export interface DownloadStore {
  loadItems(): DownloadItem[]
  saveItems(items: DownloadItem[]): void
  loadJobs(): Record<string, DownloadJob>
  saveJobs(jobs: Record<string, DownloadJob>): void
}

export interface CompletedFile {
  path: string
  size: number
  md5: string
  tagged: boolean
  tagNote: string
}

interface ProgressEvent {
  id: string
  bytes: number
  total: number
  speed: number
}
interface StateEvent {
  id: string
  state: DownloadItem['state']
  error?: string
  path?: string
  size?: number
  md5?: string
  tagged?: boolean
  tagNote?: string
  bytes?: number
}

export interface DownloadQueueOptions {
  plugin: OliDownloadPlugin
  store: DownloadStore
  /** The list changed (send it to the Downloads screen). */
  publish: (items: DownloadItem[]) => void
  /** A file arrived: make it a song. Errors mark the download as failed. */
  onCompleted: (item: DownloadItem, job: DownloadJob, file: CompletedFile) => Promise<void> | void
  newId?: () => string
  now?: () => number
}

const MAX_KEPT = 200

export class DownloadQueue {
  private items: DownloadItem[]
  private jobs: Record<string, DownloadJob>
  private readonly newId: () => string
  private readonly now: () => number
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private opts: DownloadQueueOptions) {
    this.newId = opts.newId ?? ((): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`)
    this.now = opts.now ?? Date.now
    this.items = opts.store.loadItems()
    this.jobs = opts.store.loadJobs()
  }

  /** Connect to the plugin and carry on with what was interrupted (queued / running downloads continue from their part files). */
  async start(): Promise<void> {
    try {
      await this.opts.plugin.addListener('dlProgress', (d: ProgressEvent) => this.onProgress(d))
      await this.opts.plugin.addListener('dlState', (d: StateEvent) => void this.onState(d))
    } catch {
      // without events the list would not move; nothing else to do
    }
    let active = new Set<string>()
    try {
      active = new Set((await this.opts.plugin.getActive()).ids)
    } catch {
      // treat as none
    }
    for (const item of this.items) {
      if ((item.state === 'queued' || item.state === 'downloading') && !active.has(item.id)) {
        if (this.jobs[item.id]) {
          this.patch(item.id, { state: 'queued', speed: 0, error: null })
          void this.send(item.id)
        } else {
          this.patch(item.id, { state: 'failed', speed: 0, error: 'Interrupted' })
        }
      }
    }
    this.commit()
  }

  list(): DownloadItem[] {
    return [...this.items]
  }

  /** Adds downloads (an identical URL that is queued / running / paused is not added twice). Returns how many were added. */
  add(entries: DownloadEnqueue[]): number {
    let added = 0
    for (const e of entries) {
      if (this.items.some((d) => d.url === e.job.url && ['queued', 'downloading', 'paused'].includes(d.state))) continue
      const id = this.newId()
      const t = this.now()
      this.jobs[id] = e.job
      this.items = [
        {
          id,
          title: e.title,
          url: e.job.url,
          destPath: e.job.relPath,
          state: 'queued',
          progress: 0,
          totalBytes: e.job.size > 0 ? e.job.size : null,
          downloadedBytes: 0,
          speed: 0,
          etaSeconds: null,
          error: null,
          createdAt: t,
          updatedAt: t
        },
        ...this.items
      ]
      added++
      void this.send(id)
    }
    this.commit()
    return added
  }

  private async send(id: string): Promise<void> {
    const job = this.jobs[id]
    if (!job) return
    try {
      await this.opts.plugin.enqueue({
        id,
        url: job.url,
        relPath: job.relPath,
        size: job.size,
        md5: job.md5,
        coverUrl: job.coverUrl,
        tags: job.tags,
        headers: job.headers
      })
    } catch (err) {
      this.patch(id, { state: 'failed', speed: 0, error: String((err as Error)?.message ?? err) })
      this.commit()
    }
  }

  pause(id: string): void {
    const d = this.find(id)
    if (!d || (d.state !== 'queued' && d.state !== 'downloading')) return
    void this.opts.plugin.pause({ id }).catch(() => undefined)
    // the plugin confirms with a "paused" event; a queued item that never started is paused right away
    if (d.state === 'queued') this.patch(id, { state: 'paused', speed: 0 })
    this.commit()
  }

  resume(id: string): void {
    const d = this.find(id)
    if (!d || d.state !== 'paused') return
    this.patch(id, { state: 'queued', error: null })
    this.commit()
    void this.send(id)
  }

  retry(id: string): void {
    const d = this.find(id)
    if (!d || (d.state !== 'failed' && d.state !== 'canceled') || !this.jobs[id]) return
    this.patch(id, { state: 'queued', error: null, speed: 0 })
    this.commit()
    void this.send(id)
  }

  cancel(id: string): void {
    const d = this.find(id)
    const job = this.jobs[id]
    if (!d || !job || d.state === 'completed' || d.state === 'canceled') return
    void this.opts.plugin.cancel({ id, relPath: job.relPath }).catch(() => undefined)
    this.patch(id, { state: 'canceled', speed: 0, etaSeconds: null })
    this.commit()
  }

  remove(id: string): void {
    const d = this.find(id)
    if (d && (d.state === 'queued' || d.state === 'downloading' || d.state === 'paused')) this.cancel(id)
    this.items = this.items.filter((x) => x.id !== id)
    delete this.jobs[id]
    this.commit()
  }

  clearCompleted(): void {
    const drop = new Set(this.items.filter((d) => ['completed', 'failed', 'canceled'].includes(d.state)).map((d) => d.id))
    this.items = this.items.filter((d) => !drop.has(d.id))
    for (const id of drop) delete this.jobs[id]
    this.commit()
  }

  /** Cancels everything that has not finished. Returns how many. */
  clearPending(): number {
    const pending = this.items.filter((d) => ['queued', 'downloading', 'paused'].includes(d.state))
    for (const d of pending) this.cancel(d.id)
    return pending.length
  }

  pauseAll(): number {
    const running = this.items.filter((d) => d.state === 'queued' || d.state === 'downloading')
    for (const d of running) this.pause(d.id)
    return running.length
  }

  resumeAll(): number {
    const paused = this.items.filter((d) => d.state === 'paused')
    for (const d of paused) this.resume(d.id)
    return paused.length
  }

  // ---------------------------------------------------------------- events from the plugin
  private onProgress(e: ProgressEvent): void {
    const d = this.find(e.id)
    if (!d || d.state === 'paused' || d.state === 'canceled') return
    const total = e.total > 0 ? e.total : (d.totalBytes ?? 0)
    this.patch(e.id, {
      state: 'downloading',
      downloadedBytes: e.bytes,
      totalBytes: total || null,
      progress: total ? Math.min(1, e.bytes / total) : 0,
      speed: e.speed,
      etaSeconds: total && e.speed > 0 ? Math.round((total - e.bytes) / e.speed) : null
    })
    // progress is frequent: tell the screen, but do not write storage each time
    this.opts.publish([...this.items])
  }

  private async onState(e: StateEvent): Promise<void> {
    const d = this.find(e.id)
    if (!d) return
    switch (e.state) {
      case 'queued':
        if (d.state !== 'paused' && d.state !== 'canceled') this.patch(e.id, { state: 'queued' })
        break
      case 'downloading':
        if (d.state === 'paused' || d.state === 'canceled') return // late event after the user's action
        this.patch(e.id, { state: 'downloading', error: null })
        break
      case 'paused':
        if (d.state === 'canceled') return
        this.patch(e.id, { state: 'paused', speed: 0, etaSeconds: null, downloadedBytes: e.bytes ?? d.downloadedBytes })
        break
      case 'canceled':
        this.patch(e.id, { state: 'canceled', speed: 0, etaSeconds: null })
        break
      case 'failed':
        if (d.state === 'canceled' || d.state === 'paused') return
        this.patch(e.id, { state: 'failed', speed: 0, etaSeconds: null, error: e.error || 'Download failed' })
        break
      case 'completed': {
        const job = this.jobs[e.id]
        const file: CompletedFile = {
          path: e.path ?? '',
          size: e.size ?? 0,
          md5: e.md5 ?? '',
          tagged: e.tagged === true,
          tagNote: e.tagNote ?? ''
        }
        this.patch(e.id, {
          state: 'completed',
          progress: 1,
          speed: 0,
          etaSeconds: null,
          downloadedBytes: file.size,
          totalBytes: file.size,
          destPath: file.path,
          error: null
        })
        this.commit()
        if (job) {
          try {
            await this.opts.onCompleted(this.find(e.id) ?? d, job, file)
          } catch (err) {
            this.patch(e.id, { state: 'failed', error: `Saved, but could not be added to the library: ${String((err as Error)?.message ?? err)}` })
          }
        }
        break
      }
    }
    this.commit()
  }

  // ---------------------------------------------------------------- helpers
  private find(id: string): DownloadItem | undefined {
    return this.items.find((d) => d.id === id)
  }

  private patch(id: string, p: Partial<DownloadItem>): void {
    this.items = this.items.map((d) => (d.id === id ? { ...d, ...p, updatedAt: this.now() } : d))
  }

  private commit(): void {
    this.opts.publish([...this.items])
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flush()
    }, 200)
  }

  /** Writes the list now (called at once on state changes, throttled). */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    // finished / failed entries beyond the newest 200 are forgotten together with their jobs
    if (this.items.length > MAX_KEPT) {
      const keep = this.items.slice(0, MAX_KEPT)
      const ids = new Set(keep.map((d) => d.id))
      for (const id of Object.keys(this.jobs)) if (!ids.has(id)) delete this.jobs[id]
      this.items = keep
    }
    this.opts.store.saveItems(this.items)
    this.opts.store.saveJobs(this.jobs)
  }
}

/** The Capacitor plugin, or null when this is not the Android app (or the APK has no OliDownload plugin). */
interface CapacitorGlobal {
  getPlatform?: () => string
  registerPlugin?: <T>(name: string) => T
  PluginHeaders?: Array<{ name: string }>
}
let proxy: OliDownloadPlugin | null = null
export function getDownloadPlugin(): OliDownloadPlugin | null {
  if (proxy) return proxy
  if (typeof window === 'undefined') return null
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor
  if (!cap || cap.getPlatform?.() !== 'android' || !cap.registerPlugin) return null
  if (Array.isArray(cap.PluginHeaders) && !cap.PluginHeaders.some((h) => h.name === 'OliDownload')) return null
  proxy = cap.registerPlugin<OliDownloadPlugin>('OliDownload')
  return proxy
}
