import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Track } from '@shared/types'

// ----------------------------------------------------------------- fakes
// A minimal HTMLAudioElement stand-in: tests drive the media events that
// Chromium would fire (playing, pause, waiting, error, ended) by hand.

class FakeAudio extends EventTarget {
  static last: FakeAudio | null = null
  paused = true
  currentTime = 0
  duration = NaN
  readyState = 0
  error: { code: number } | null = null
  volume = 1
  muted = false
  preload = ''
  private _src = ''
  srcHistory: string[] = []

  constructor() {
    super()
    FakeAudio.last = this
  }
  get src(): string {
    return this._src
  }
  set src(v: string) {
    this._src = v
    this.srcHistory.push(v)
    // Like the real load algorithm: position resets, metadata unknown.
    this.currentTime = 0
    this.duration = NaN
    this.readyState = 0
    this.error = null
  }
  get currentSrc(): string {
    return this._src
  }
  play(): Promise<void> {
    if (this.paused) {
      this.paused = false
      this.fire('play')
    }
    return Promise.resolve()
  }
  pause(): void {
    if (!this.paused) {
      this.paused = true
      this.fire('pause')
    }
  }
  removeAttribute(): void {
    this._src = ''
  }
  fire(type: string): void {
    this.dispatchEvent(new Event(type))
  }
  /** Simulate metadata + audio actually starting. */
  start(duration = 200): void {
    this.duration = duration
    this.readyState = 4
    this.fire('loadedmetadata')
    this.fire('playing')
  }
}

;(globalThis as unknown as { Audio: typeof FakeAudio }).Audio = FakeAudio
;(globalThis as unknown as { HTMLMediaElement: { HAVE_FUTURE_DATA: number } }).HTMLMediaElement = {
  HAVE_FUTURE_DATA: 3
}

const ipc = vi.hoisted(() => ({
  transcodeLocalFile: vi.fn(async (): Promise<string | null> => null),
  resolveYouTubeStream: vi.fn(async (): Promise<string[]> => []),
  resolveDownloadYouTubeAudio: vi.fn(async (): Promise<string | null> => null)
}))

vi.mock('../src/renderer/src/lib/ipc', () => ({
  sendPlaybackState: vi.fn(),
  saveQueue: vi.fn(async () => undefined),
  getQueue: vi.fn(async () => []),
  getSettings: vi.fn(async () => ({ volume: 0.5 })),
  setSettings: vi.fn(async () => ({})),
  getSongById: vi.fn(async () => null),
  clearQueue: vi.fn(async () => undefined),
  transcodeLocalFile: ipc.transcodeLocalFile,
  probeDuration: vi.fn(async () => null),
  resolveYouTubeStream: ipc.resolveYouTubeStream,
  resolveDownloadYouTubeAudio: ipc.resolveDownloadYouTubeAudio,
  getSimilarTracks: vi.fn(async () => [])
}))

const { usePlayer } = await import('../src/renderer/src/store/player')

function track(id: string, extra: Partial<Track> = {}): Track {
  return {
    id,
    title: id,
    artist: 'A',
    path: `C:\\music\\${id}.mp3`,
    duration: 200,
    codec: 'mp3',
    ...extra
  } as Track
}

const audio = (): FakeAudio => FakeAudio.last!
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const initial = usePlayer.getState()

beforeEach(async () => {
  vi.useRealTimers()
  usePlayer.setState({ ...initial, queue: [], index: -1, current: null, status: 'idle', history: [] })
  await usePlayer.getState().hydrate()
  ipc.transcodeLocalFile.mockReset().mockResolvedValue(null)
  ipc.resolveYouTubeStream.mockReset().mockResolvedValue([])
  ipc.resolveDownloadYouTubeAudio.mockReset().mockResolvedValue(null)
})

// ----------------------------------------------------------------- tests

describe('pause / resume', () => {
  it('resuming after a pause keeps the same song and position', () => {
    const p = usePlayer.getState()
    p.playTracks([track('a'), track('b'), track('c')], 0, { source: 'library', sourceId: null })
    audio().start()
    audio().currentTime = 42
    p.toggle() // pause
    expect(usePlayer.getState().status).toBe('paused')
    p.toggle() // resume
    audio().fire('playing')
    const s = usePlayer.getState()
    expect(s.current?.id).toBe('a')
    expect(s.index).toBe(0)
    expect(audio().currentTime).toBe(42)
  })

  it('a connection dropped during pause is reopened in place, not skipped', () => {
    const p = usePlayer.getState()
    p.playTracks([track('a'), track('b')], 0, { source: 'library', sourceId: null })
    audio().start()
    audio().currentTime = 95
    p.toggle() // pause
    p.toggle() // resume
    // The stale source errors out on resume.
    audio().error = { code: 2 }
    audio().fire('error')
    expect(usePlayer.getState().current?.id).toBe('a')
    // Same source reopened; position restored once metadata loads.
    expect(audio().srcHistory.at(-1)).toContain('a.mp3')
    audio().start()
    expect(audio().currentTime).toBe(95)
    expect(ipc.transcodeLocalFile).not.toHaveBeenCalled()
  })

  it('a stall after resume never skips while the user just resumed', () => {
    vi.useFakeTimers()
    const p = usePlayer.getState()
    p.playTracks([track('a'), track('b')], 0, { source: 'library', sourceId: null })
    audio().start()
    audio().currentTime = 30
    p.toggle()
    p.toggle()
    audio().readyState = 2
    audio().fire('waiting')
    vi.advanceTimersByTime(25_000)
    expect(usePlayer.getState().current?.id).toBe('a')
  })

  it('pressing pause while buffering pauses instead of doing nothing', () => {
    const p = usePlayer.getState()
    p.playTracks([track('a')], 0, { source: 'library', sourceId: null })
    audio().start()
    audio().fire('waiting')
    expect(usePlayer.getState().status).toBe('loading')
    p.toggle()
    expect(audio().paused).toBe(true)
    expect(usePlayer.getState().status).toBe('paused')
  })
})

describe('stream fallbacks', () => {
  it('tries every pre-resolved URL, including the second one', () => {
    const p = usePlayer.getState()
    const t = track('youtube:xyz', { path: '', streamUrls: ['https://u0', 'https://u1', 'https://u2'] })
    p.playTracks([t], 0, { source: 'search', sourceId: null })
    expect(audio().src).toBe('https://u0')
    vi.useFakeTimers()
    audio().fire('error')
    vi.advanceTimersByTime(400)
    // Previously u1 was skipped (off-by-one) and u2 tried directly.
    expect(audio().src).toBe('https://u1')
  })
})

describe('queue navigation', () => {
  it('restored queue starts at the first track, not the second', async () => {
    const { getQueue } = await import('../src/renderer/src/lib/ipc')
    ;(getQueue as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { track: track('q1') },
      { track: track('q2') }
    ])
    usePlayer.setState({ queue: [], index: -1, current: null, status: 'idle', history: [] })
    await usePlayer.getState().hydrate()
    usePlayer.getState().toggle()
    expect(usePlayer.getState().current?.id).toBe('q1')
  })

  it('duplicate tracks are collapsed and the clicked one plays', () => {
    const p = usePlayer.getState()
    p.playTracks([track('a'), track('b'), track('a'), track('c')], 3, { source: 'playlist', sourceId: 'x' })
    const s = usePlayer.getState()
    expect(s.queue.map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect(s.current?.id).toBe('c')
    expect(s.index).toBe(2)
  })

  it('shuffle plays every track once before repeating', () => {
    const p = usePlayer.getState()
    usePlayer.setState({ shuffle: true, repeat: 'off' })
    const ids = ['a', 'b', 'c', 'd', 'e']
    p.playTracks(ids.map((i) => track(i)), 0, { source: 'library', sourceId: null })
    const heard = [usePlayer.getState().current!.id]
    for (let i = 0; i < ids.length - 1; i++) {
      p.next(true)
      heard.push(usePlayer.getState().current!.id)
    }
    expect(new Set(heard).size).toBe(ids.length)
    p.next(true) // all played, repeat off: stops
    expect(usePlayer.getState().status).toBe('ended')
    usePlayer.setState({ shuffle: false })
  })

  it('an unplayable track is skipped even with repeat-one', async () => {
    const p = usePlayer.getState()
    usePlayer.setState({ repeat: 'one' })
    p.playTracks([track('bad'), track('good')], 0, { source: 'library', sourceId: null })
    audio().error = { code: 4 }
    audio().fire('error') // -> transcode attempt (returns null) -> skip
    await flush()
    await flush()
    expect(usePlayer.getState().current?.id).toBe('good')
    usePlayer.setState({ repeat: 'off' })
  })

  it('a queue where every track fails stops instead of looping forever', async () => {
    const p = usePlayer.getState()
    usePlayer.setState({ repeat: 'queue' })
    p.playTracks([track('x'), track('y')], 0, { source: 'library', sourceId: null })
    for (let i = 0; i < 6; i++) {
      audio().error = { code: 4 }
      audio().fire('error')
      await flush()
      await flush()
    }
    expect(usePlayer.getState().status).toBe('idle')
    usePlayer.setState({ repeat: 'off' })
  })

  it('repeat-one replays in place when the song ends', () => {
    const p = usePlayer.getState()
    usePlayer.setState({ repeat: 'one' })
    p.playTracks([track('a'), track('b')], 0, { source: 'library', sourceId: null })
    audio().start()
    audio().currentTime = 200
    audio().pause()
    audio().fire('ended')
    expect(usePlayer.getState().current?.id).toBe('a')
    expect(audio().currentTime).toBe(0)
    expect(audio().paused).toBe(false)
    usePlayer.setState({ repeat: 'off' })
  })
})
