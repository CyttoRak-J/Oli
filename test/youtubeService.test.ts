import { beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { YouTubeService, type OliYouTubePlugin } from '../src/renderer/src/platform/youtubeService'
import type { YtEngineStatus } from '../src/shared/types'

const fx = (name: string): string => fs.readFileSync(path.join(__dirname, 'fixtures/yt', name), 'utf8')

interface Call {
  name: string
  arg?: Record<string, unknown>
}

function fakePlugin(): {
  plugin: OliYouTubePlugin
  calls: Call[]
  answers: Record<string, () => Promise<unknown>>
} {
  const calls: Call[] = []
  const answers: Record<string, () => Promise<unknown>> = {
    status: async () => ({ ready: true, version: '2026.08.19', versionName: '2026.08.19' }),
    updateEngine: async () => ({ status: 'DONE', version: '2026.09.20' }),
    search: async () => ({ json: fx('search.json') }),
    playlist: async () => ({ json: fx('playlist.json') }),
    info: async () => ({ json: fx('stream.json') })
  }
  const call =
    (name: string) =>
    async (arg?: Record<string, unknown>): Promise<unknown> => {
      calls.push({ name, arg })
      return answers[name]()
    }
  const plugin = {
    status: call('status'),
    updateEngine: call('updateEngine'),
    search: call('search'),
    playlist: call('playlist'),
    info: call('info'),
    enqueue: async () => undefined,
    pause: async () => undefined,
    resume: async () => undefined,
    cancel: async () => undefined,
    getActive: async () => ({ ids: [] }),
    addListener: async () => ({ remove: async () => undefined })
  } as unknown as OliYouTubePlugin
  return { plugin, calls, answers }
}

describe('YouTubeService', () => {
  let fp: ReturnType<typeof fakePlugin>
  let svc: YouTubeService
  let headers: Array<[string, Record<string, string>]>
  let statuses: YtEngineStatus[]
  let latest: string | null
  let auto: boolean
  let clock: number

  beforeEach(() => {
    fp = fakePlugin()
    headers = []
    statuses = []
    latest = '2026.08.19'
    auto = false
    clock = 1_000_000_000_000
    svc = new YouTubeService({
      plugin: fp.plugin,
      latestVersion: async () => latest,
      setStreamHeaders: (u, h) => headers.push([u, h]),
      emitStatus: (s) => statuses.push(s),
      autoUpdate: () => auto,
      now: () => clock
    })
  })
  const count = (name: string): number => fp.calls.filter((c) => c.name === name).length

  it('search reads the results, remembers them for an hour, and shares one run between identical questions', async () => {
    const [a, b] = await Promise.all([svc.search('Vinnaithaandi'), svc.search('vinnaithaandi ')])
    expect(a).toHaveLength(3)
    expect(b).toEqual(a)
    expect(count('search')).toBe(1)
    expect(fp.calls[0].arg).toMatchObject({ query: 'Vinnaithaandi', count: 20 })
    await svc.search('vinnaithaandi')
    expect(count('search')).toBe(1)
    clock += 2 * 3600_000
    await svc.search('vinnaithaandi')
    expect(count('search')).toBe(2)
    expect(await svc.search('   ')).toEqual([])
    fp.answers.search = async () => {
      throw new Error('boom')
    }
    expect(await svc.search('something else')).toEqual([])
  })

  it('knows which channel a listed video came from (for download tags)', async () => {
    await svc.search('vinnaithaandi')
    expect(svc.channelOf('4ucog3jt95Q')).toBe('SonyMusicSouthVEVO')
    expect(svc.channelOf('AAAAAAAAAAA')).toBeNull()
  })

  it('a pasted video link becomes one row from its description', async () => {
    const rows = await svc.resolveUrl('https://youtu.be/4ucog3jt95Q?t=3')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'youtube:4ucog3jt95Q', artist: 'SonyMusicSouthVEVO', videoId: '4ucog3jt95Q' })
    expect(rows[0].title).toContain('Vinnaithaandi')
    expect(await svc.resolveUrl('https://example.com/watch?v=4ucog3jt95Q')).toEqual([])
    expect(await svc.resolveUrl('not a link')).toEqual([])
  })

  it('a pasted playlist link lists its videos; a Mix needs one of its videos; results are remembered ten minutes', async () => {
    const rows = await svc.resolveUrl('https://www.youtube.com/playlist?list=PLabcdefghijk')
    expect(rows).toHaveLength(3)
    expect(rows[0].album).toBe('Harness playlist')
    expect(fp.calls.find((c) => c.name === 'playlist')?.arg).toMatchObject({ url: 'https://www.youtube.com/playlist?list=PLabcdefghijk', limit: 2000 })
    await svc.playlistEntries('https://www.youtube.com/playlist?list=PLabcdefghijk')
    expect(count('playlist')).toBe(1)
    const mix = await svc.playlistEntries('https://www.youtube.com/playlist?list=RDdQw4w9WgXcQ')
    expect(mix.error).toMatch(/Mix can only be opened from one of its videos/)
    expect(count('playlist')).toBe(1)
    const mix2 = await svc.playlistEntries('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ')
    expect(mix2.mix).toBe(true)
    expect(fp.calls.filter((c) => c.name === 'playlist').pop()?.arg).toMatchObject({ limit: 500 })
    expect((await svc.playlistEntries('https://example.com/x')).error).toMatch(/not a YouTube link/)
  })

  it('an unreadable playlist is retried once, then reported', async () => {
    fp.answers.playlist = async () => {
      throw new Error('private')
    }
    const r = await svc.playlistEntries('https://www.youtube.com/playlist?list=PLabcdefghijk')
    expect(r.entries).toEqual([])
    expect(r.error).toMatch(/Could not read this playlist/)
    expect(count('playlist')).toBe(2)
  })

  it('stream addresses: resolved once, headers handed to the player, remembered until they expire, refreshed on request', async () => {
    const urls = await svc.resolveStream('4ucog3jt95Q')
    expect(urls.length).toBeGreaterThan(0)
    expect(fp.calls[0].arg).toMatchObject({ videoId: '4ucog3jt95Q', streams: true })
    expect(headers.map(([u]) => u)).toEqual(urls)
    expect(headers[0][1]['User-Agent']).toBeTruthy()
    await svc.resolveStream('4ucog3jt95Q')
    expect(count('info')).toBe(1)
    await svc.resolveStream('4ucog3jt95Q', true)
    expect(count('info')).toBe(2)
    expect(await svc.resolveStream('nope')).toEqual([])
    fp.answers.info = async () => {
      throw new Error('bot check')
    }
    expect(await svc.resolveStream('AAAAAAAAAAA')).toEqual([])
  })

  it('prefetch warms the cache one video at a time', async () => {
    svc.prefetch(['4ucog3jt95Q', 'BBBBBBBBBBB', 'nope'], false)
    await new Promise((r) => setTimeout(r, 20))
    expect(count('info')).toBe(2)
    expect((await svc.resolveStreamBatch(['4ucog3jt95Q', 'BBBBBBBBBBB'])).map((r) => r.urls.length > 0)).toEqual([true, true])
    expect(count('info')).toBe(2)
  })

  it('the engine: starts, reports its version, notices a newer release, installs it (also by itself when allowed)', async () => {
    let st = await svc.start()
    expect(st).toMatchObject({ state: 'ok', version: '2026.08.19' })
    latest = '2026.09.20'
    st = await svc.check()
    expect(st).toMatchObject({ state: 'update-available', latest: '2026.09.20' })
    st = await svc.install()
    expect(st).toMatchObject({ state: 'ok', version: '2026.09.20' })
    expect(st.message).toMatch(/updated to 2026\.09\.20/)
    auto = true
    latest = '2026.10.01'
    fp.answers.updateEngine = async () => ({ status: 'DONE', version: '2026.10.01' })
    st = await svc.check()
    expect(st).toMatchObject({ state: 'ok', version: '2026.10.01' })
    expect(statuses.some((s) => s.state === 'installing')).toBe(true)
  })

  it('engine problems are reported, not thrown', async () => {
    fp.answers.status = async () => ({ ready: false, error: 'python missing' })
    expect(await svc.start()).toMatchObject({ state: 'broken', message: 'python missing' })
    fp.answers.status = async () => {
      throw new Error('bridge gone')
    }
    expect(await svc.start()).toMatchObject({ state: 'failed' })
    fp.answers.status = async () => ({ ready: true, version: '2026.08.19' })
    await svc.start()
    fp.answers.updateEngine = async () => {
      throw new Error('no network')
    }
    const st = await svc.install()
    expect(st.state).toBe('failed')
    expect(st.message).toMatch(/no network/)
  })
})
