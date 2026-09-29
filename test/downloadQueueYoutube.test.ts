import { beforeEach, describe, expect, it } from 'vitest'
import type { DownloadItem } from '../src/shared/types'
import {
  DownloadQueue,
  type DownloadJob,
  type DownloadStore,
  type OliDownloadPlugin,
  type YouTubeDownloadPlugin
} from '../src/renderer/src/platform/downloadQueue'

interface Call {
  plugin: 'http' | 'youtube'
  name: string
  arg?: Record<string, unknown>
}

function makePlugins(): {
  http: OliDownloadPlugin
  youtube: YouTubeDownloadPlugin
  calls: Call[]
  fire: (event: string, data: Record<string, unknown>, from?: 'http' | 'youtube') => void
} {
  const calls: Call[] = []
  const listeners: Array<{ plugin: 'http' | 'youtube'; event: string; cb: (d: unknown) => void }> = []
  const mk = (plugin: 'http' | 'youtube') => {
    const rec =
      (name: string) =>
      async (arg?: Record<string, unknown>): Promise<void> => {
        calls.push({ plugin, name, arg })
      }
    return {
      enqueue: rec('enqueue'),
      pause: rec('pause'),
      resume: rec('resume'),
      cancel: rec('cancel'),
      getActive: async () => ({ ids: [] }),
      getRoot: async () => ({ root: '/files' }),
      writeTags: async () => ({ written: true, note: '' }),
      addListener: async (event: string, cb: (d: unknown) => void) => {
        listeners.push({ plugin, event, cb })
        return { remove: async () => undefined }
      }
    }
  }
  return {
    http: mk('http') as unknown as OliDownloadPlugin,
    youtube: mk('youtube') as unknown as YouTubeDownloadPlugin,
    calls,
    // an event reaches the listener of the plugin it came from (default: the YouTube one)
    fire: (event, data, from = 'youtube') => listeners.filter((l) => l.event === event && l.plugin === from).forEach((l) => l.cb(data))
  }
}

const store = (): DownloadStore => {
  let items: DownloadItem[] = []
  let jobs: Record<string, DownloadJob> = {}
  return { loadItems: () => items, saveItems: (i) => (items = i), loadJobs: () => jobs, saveJobs: (j) => (jobs = j) }
}

const ytJob = (id = 'dQw4w9WgXcQ'): DownloadJob => ({
  url: `https://www.youtube.com/watch?v=${id}`,
  relPath: `Oli/YouTube/x [${id}]`,
  size: 0,
  md5: '',
  youtube: { videoId: id, mode: 'song', audio: 'best', height: 0, relBase: `Oli/YouTube/x [${id}]`, title: 'Guess', artist: 'Unknown Artist', album: '' }
})

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

describe('DownloadQueue with YouTube downloads', () => {
  let p: ReturnType<typeof makePlugins>
  let q: DownloadQueue
  let completed: string[]

  beforeEach(async () => {
    p = makePlugins()
    completed = []
    q = new DownloadQueue({
      plugin: p.http,
      youtube: p.youtube,
      store: store(),
      publish: () => undefined,
      onCompleted: (d) => {
        completed.push(d.id)
      },
      newId: (() => {
        let n = 0
        return () => `y${++n}`
      })()
    })
    await q.start()
  })

  it('a YouTube job goes to the YouTube plugin, a file job to the file plugin', async () => {
    q.add([
      { title: 'Song', job: ytJob() },
      { title: 'File', job: { url: 'https://x/a.flac', relPath: 'Oli/a.flac', size: 5, md5: '' } }
    ])
    await settle()
    expect(p.calls.map((c) => `${c.plugin}:${c.name}`)).toEqual(['youtube:enqueue', 'http:enqueue'])
    expect(p.calls[0].arg).toMatchObject({ id: 'y1', videoId: 'dQw4w9WgXcQ', mode: 'song', relBase: 'Oli/YouTube/x [dQw4w9WgXcQ]', title: 'Guess' })
  })

  it('events from either plugin move the same list; pause / cancel are sent to the right plugin', async () => {
    q.add([{ title: 'Song', job: ytJob() }])
    await settle()
    p.fire('dlState', { id: 'y1', state: 'downloading' })
    p.fire('dlProgress', { id: 'y1', bytes: 500, total: 1000, speed: 50 })
    expect(q.list()[0]).toMatchObject({ state: 'downloading', progress: 0.5 })
    p.calls.length = 0
    q.pause('y1')
    expect(p.calls).toEqual([{ plugin: 'youtube', name: 'pause', arg: { id: 'y1' } }])
    p.fire('dlState', { id: 'y1', state: 'paused', bytes: 500 })
    p.calls.length = 0
    q.resume('y1')
    await settle()
    expect(p.calls.map((c) => `${c.plugin}:${c.name}`)).toEqual(['youtube:enqueue'])
    p.calls.length = 0
    q.cancel('y1')
    expect(p.calls).toEqual([{ plugin: 'youtube', name: 'cancel', arg: { id: 'y1' } }])
    // the cancel came too late and the file finished: it is on disk, so it is kept and becomes a song
    p.fire('dlState', { id: 'y1', state: 'completed', path: 'file:///f.m4a', size: 3 })
    await settle()
    expect(q.list()[0].state).toBe('completed')
    expect(completed).toEqual(['y1'])
  })

  it('the tags are read before the transfer starts (prepare), and the list shows the real title', async () => {
    q.add([
      {
        title: 'YouTube song',
        job: ytJob(),
        prepare: async () => ({ title: 'Real title', youtube: { title: 'Real title', artist: 'Real artist', album: 'Real album' }, meta: { kind: 'youtube', duration: 200 } })
      }
    ])
    expect(p.calls).toHaveLength(0) // not sent yet
    await settle()
    expect(p.calls).toHaveLength(1)
    expect(p.calls[0].arg).toMatchObject({ title: 'Real title', artist: 'Real artist', album: 'Real album', videoId: 'dQw4w9WgXcQ' })
    expect(q.list()[0].title).toBe('Real title')
  })

  it('a failing prepare starts the download with what is known; cancelling meanwhile sends nothing', async () => {
    q.add([{ title: 'A', job: ytJob('AAAAAAAAAAA'), prepare: async () => { throw new Error('offline') } }])
    await settle()
    expect(p.calls.map((c) => c.arg?.videoId)).toEqual(['AAAAAAAAAAA'])

    let release: () => void = () => undefined
    q.add([{ title: 'B', job: ytJob('BBBBBBBBBBB'), prepare: () => new Promise((r) => { release = () => r(null) }) }])
    const idB = q.list()[0].id
    q.cancel(idB)
    release()
    await settle()
    expect(p.calls.filter((c) => c.arg?.videoId === 'BBBBBBBBBBB')).toHaveLength(0)
  })

  it('without the YouTube plugin a YouTube job fails clearly instead of hanging', async () => {
    const q2 = new DownloadQueue({ plugin: p.http, store: store(), publish: () => undefined, onCompleted: () => undefined, newId: () => 'z1' })
    await q2.start()
    q2.add([{ title: 'Song', job: ytJob() }])
    await settle()
    expect(q2.list()[0]).toMatchObject({ state: 'failed' })
    expect(q2.list()[0].error).toMatch(/not available/)
  })
})
