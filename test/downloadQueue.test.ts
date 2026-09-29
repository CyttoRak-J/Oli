import { beforeEach, describe, expect, it } from 'vitest'
import type { DownloadItem } from '../src/shared/types'
import {
  DownloadQueue,
  type CompletedFile,
  type DownloadJob,
  type DownloadStore,
  type OliDownloadPlugin
} from '../src/renderer/src/platform/downloadQueue'

interface Call {
  name: string
  arg?: Record<string, unknown>
}

function fakePlugin(active: string[] = []): {
  plugin: OliDownloadPlugin
  calls: Call[]
  fire: (event: string, data: Record<string, unknown>) => void
  failEnqueue: { on: boolean }
} {
  const calls: Call[] = []
  const listeners = new Map<string, Array<(d: unknown) => void>>()
  const failEnqueue = { on: false }
  const rec =
    (name: string) =>
    async (arg?: Record<string, unknown>): Promise<void> => {
      calls.push({ name, arg })
      if (name === 'enqueue' && failEnqueue.on) throw new Error('service could not start')
    }
  const plugin = {
    getRoot: async () => ({ root: '/files' }),
    enqueue: rec('enqueue'),
    pause: rec('pause'),
    resume: rec('resume'),
    cancel: rec('cancel'),
    getActive: async () => ({ ids: active }),
    addListener: async (event: string, cb: (d: unknown) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), cb])
      return { remove: async () => undefined }
    }
  } as unknown as OliDownloadPlugin
  return { plugin, calls, fire: (e, d) => (listeners.get(e) ?? []).forEach((cb) => cb(d)), failEnqueue }
}

function memoryStore(items: DownloadItem[] = [], jobs: Record<string, DownloadJob> = {}): DownloadStore & { items: DownloadItem[]; jobs: Record<string, DownloadJob> } {
  const s = {
    items,
    jobs,
    loadItems: () => s.items,
    saveItems: (i: DownloadItem[]) => {
      s.items = i
    },
    loadJobs: () => s.jobs,
    saveJobs: (j: Record<string, DownloadJob>) => {
      s.jobs = j
    }
  }
  return s
}

const job = (n: number, extra: Partial<DownloadJob> = {}): DownloadJob => ({
  url: `https://archive.org/download/x/${n}.flac`,
  relPath: `Oli/X/${n}.flac`,
  size: 1000,
  md5: `md5-${n}`,
  ...extra
})

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

describe('DownloadQueue', () => {
  let ids = 0
  let published: DownloadItem[][]
  let completed: Array<{ id: string; file: CompletedFile }>
  let fp: ReturnType<typeof fakePlugin>
  let store: ReturnType<typeof memoryStore>
  let q: DownloadQueue

  const make = async (items: DownloadItem[] = [], jobs: Record<string, DownloadJob> = {}, active: string[] = []): Promise<void> => {
    fp = fakePlugin(active)
    store = memoryStore(items, jobs)
    published = []
    completed = []
    q = new DownloadQueue({
      plugin: fp.plugin,
      store,
      publish: (i) => published.push(i),
      onCompleted: (d, _j, file) => {
        completed.push({ id: d.id, file })
      },
      newId: () => `d${++ids}`
    })
    await q.start()
  }
  const state = (id: string): DownloadItem['state'] | undefined => q.list().find((d) => d.id === id)?.state

  beforeEach(async () => {
    ids = 0
    await make()
  })

  it('adds downloads, sends them to the native queue with their tags and checksum, and does not add a duplicate', async () => {
    const n = q.add([
      { title: 'One', job: job(1, { tags: { title: 'One', artist: 'A' }, coverUrl: 'https://x/c.jpg' }) },
      { title: 'Two', job: job(2) }
    ])
    expect(n).toBe(2)
    expect(q.add([{ title: 'One again', job: job(1) }])).toBe(0)
    await settle()
    const enq = fp.calls.filter((c) => c.name === 'enqueue')
    expect(enq).toHaveLength(2)
    expect(enq[0].arg).toMatchObject({ url: job(1).url, relPath: 'Oli/X/1.flac', md5: 'md5-1', size: 1000, coverUrl: 'https://x/c.jpg', tags: { title: 'One', artist: 'A' } })
    expect(q.list().map((d) => [d.title, d.state])).toEqual([['Two', 'queued'], ['One', 'queued']])
  })

  it('follows progress and completion, then asks for the song to be made', async () => {
    q.add([{ title: 'One', job: job(1) }])
    fp.fire('dlState', { id: 'd1', state: 'downloading' })
    fp.fire('dlProgress', { id: 'd1', bytes: 250, total: 1000, speed: 100 })
    const d = q.list()[0]
    expect(d).toMatchObject({ state: 'downloading', progress: 0.25, downloadedBytes: 250, speed: 100, etaSeconds: 8 })
    fp.fire('dlState', { id: 'd1', state: 'completed', path: 'file:///files/Oli/X/1.flac', size: 1000, md5: 'md5-1', tagged: true, tagNote: '' })
    await settle()
    expect(state('d1')).toBe('completed')
    expect(completed).toEqual([{ id: 'd1', file: { path: 'file:///files/Oli/X/1.flac', size: 1000, md5: 'md5-1', tagged: true, tagNote: '' } }])
    expect(q.list()[0]).toMatchObject({ progress: 1, destPath: 'file:///files/Oli/X/1.flac' })
  })

  it('pause, resume, cancel and retry map onto the plugin', async () => {
    q.add([{ title: 'One', job: job(1) }])
    fp.fire('dlState', { id: 'd1', state: 'downloading' })
    q.pause('d1')
    expect(fp.calls.some((c) => c.name === 'pause')).toBe(true)
    fp.fire('dlState', { id: 'd1', state: 'paused', bytes: 400 })
    expect(state('d1')).toBe('paused')
    // a late progress event must not un-pause it
    fp.fire('dlProgress', { id: 'd1', bytes: 500, total: 1000, speed: 1 })
    expect(state('d1')).toBe('paused')
    fp.calls.length = 0
    q.resume('d1')
    await settle()
    expect(fp.calls.map((c) => c.name)).toEqual(['enqueue'])
    expect(state('d1')).toBe('queued')
    fp.fire('dlState', { id: 'd1', state: 'failed', error: 'Connection problem: reset' })
    expect(q.list()[0]).toMatchObject({ state: 'failed', error: 'Connection problem: reset' })
    fp.calls.length = 0
    q.retry('d1')
    await settle()
    expect(fp.calls.map((c) => c.name)).toEqual(['enqueue'])
    q.cancel('d1')
    expect(fp.calls.find((c) => c.name === 'cancel')?.arg).toEqual({ id: 'd1', relPath: 'Oli/X/1.flac' })
    expect(state('d1')).toBe('canceled')
    // "failed" arriving after the user cancelled is ignored
    fp.fire('dlState', { id: 'd1', state: 'failed', error: 'x' })
    expect(state('d1')).toBe('canceled')
  })

  it('pauseAll / resumeAll / clearPending / clearCompleted / remove', async () => {
    q.add([
      { title: 'A', job: job(1) },
      { title: 'B', job: job(2) },
      { title: 'C', job: job(3) }
    ])
    fp.fire('dlState', { id: 'd3', state: 'completed', path: 'file:///f', size: 1, md5: '' })
    await settle()
    expect(q.pauseAll()).toBe(2)
    fp.fire('dlState', { id: 'd1', state: 'paused', bytes: 0 })
    fp.fire('dlState', { id: 'd2', state: 'paused', bytes: 0 })
    expect(q.resumeAll()).toBe(2)
    expect(q.clearPending()).toBe(2)
    expect(q.list().filter((d) => d.state === 'canceled')).toHaveLength(2)
    q.clearCompleted()
    expect(q.list()).toHaveLength(0)
    expect(Object.keys(store.jobs)).toHaveLength(0)
    q.add([{ title: 'D', job: job(4) }])
    q.remove('d4')
    expect(q.list()).toHaveLength(0)
  })

  it('a failed hand-over to the native service marks the download failed instead of hanging', async () => {
    fp.failEnqueue.on = true
    q.add([{ title: 'One', job: job(1) }])
    await settle()
    expect(q.list()[0]).toMatchObject({ state: 'failed', error: 'service could not start' })
  })

  it('a song that cannot be added to the library after the download shows an error', async () => {
    fp = fakePlugin()
    q = new DownloadQueue({
      plugin: fp.plugin,
      store: memoryStore(),
      publish: () => undefined,
      onCompleted: () => {
        throw new Error('database is full')
      },
      newId: () => 'e1'
    })
    await q.start()
    q.add([{ title: 'One', job: job(1) }])
    fp.fire('dlState', { id: 'e1', state: 'completed', path: 'file:///f', size: 5, md5: '' })
    await settle()
    expect(q.list()[0].state).toBe('failed')
    expect(q.list()[0].error).toContain('database is full')
  })

  it('after a restart, downloads that were running continue by themselves; paused ones stay paused', async () => {
    const t = 1
    const item = (id: string, state: DownloadItem['state']): DownloadItem => ({
      id, title: id, url: `https://x/${id}`, destPath: `Oli/${id}`, state, progress: 0.3, totalBytes: 10, downloadedBytes: 3, speed: 9, etaSeconds: 1, error: null, createdAt: t, updatedAt: t
    })
    await make(
      [item('r1', 'downloading'), item('r2', 'queued'), item('r3', 'paused'), item('r4', 'completed'), item('r5', 'downloading'), item('r6', 'downloading')],
      { r1: job(1), r2: job(2), r3: job(3), r5: job(5) },
      ['r5'] // the service is still working on r5 (only the screen restarted)
    )
    await settle()
    const sent = fp.calls.filter((c) => c.name === 'enqueue').map((c) => c.arg?.id)
    expect(sent).toEqual(['r1', 'r2']) // r5 is already running natively, r3 stays paused, r6 has no job
    expect(state('r3')).toBe('paused')
    expect(state('r4')).toBe('completed')
    expect(q.list().find((d) => d.id === 'r6')).toMatchObject({ state: 'failed', error: 'Interrupted' })
  })

  it('the list and the jobs are saved, and kept to the newest 200', async () => {
    q.add(Array.from({ length: 210 }, (_, i) => ({ title: `S${i}`, job: job(i) })))
    q.flush()
    expect(store.items).toHaveLength(200)
    expect(Object.keys(store.jobs)).toHaveLength(200)
  })
})
