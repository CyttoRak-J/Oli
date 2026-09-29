import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Track } from '@shared/types'

// The real player store, driving the Android NativeAudio object over a fake plugin (the native side).
// Shows that queue, ended -> next, notification commands, outside pause/resume, errors and seeking all work
// through the same audio-element interface as on desktop.

interface Call {
  name: string
  arg?: Record<string, unknown>
}
const calls: Call[] = []
const listeners = new Map<string, Array<(d: unknown) => void>>()
const fire = (event: string, data: Record<string, unknown>): void =>
  (listeners.get(event) ?? []).forEach((cb) => cb(data))
const rec =
  (name: string) =>
  async (arg?: Record<string, unknown>): Promise<void> => {
    calls.push({ name, arg })
  }
const plugin = {
  loadSource: rec('loadSource'),
  play: rec('play'),
  pause: rec('pause'),
  stop: rec('stop'),
  seekTo: rec('seekTo'),
  setVolume: rec('setVolume'),
  setPlaybackParams: rec('setPlaybackParams'),
  setMetadata: rec('setMetadata'),
  setBitPerfect: rec('setBitPerfect'),
  getOutputInfo: async () => ({ available: true }),
  addListener: async (event: string, cb: (d: unknown) => void) => {
    listeners.set(event, [...(listeners.get(event) ?? []), cb])
    return { remove: async () => undefined }
  }
}

;(globalThis as unknown as Record<string, unknown>).__OLI_WEB__ = true
;(globalThis as unknown as Record<string, unknown>).window = {
  cytto: { platform: 'android' },
  Capacitor: { getPlatform: () => 'android', registerPlugin: () => plugin, isPluginAvailable: () => true }
}
;(globalThis as unknown as { HTMLMediaElement: { HAVE_FUTURE_DATA: number } }).HTMLMediaElement = {
  HAVE_FUTURE_DATA: 3
}

vi.mock('../src/renderer/src/lib/ipc', () => ({
  sendPlaybackState: vi.fn(),
  saveQueue: vi.fn(async () => undefined),
  getQueue: vi.fn(async () => []),
  getSettings: vi.fn(async () => ({ volume: 0.5 })),
  setSettings: vi.fn(async () => ({})),
  getSongById: vi.fn(async () => null),
  clearQueue: vi.fn(async () => undefined),
  transcodeLocalFile: vi.fn(async () => null),
  probeDuration: vi.fn(async () => null),
  resolveYouTubeStream: vi.fn(async () => []),
  resolveDownloadYouTubeAudio: vi.fn(async () => null),
  getSimilarTracks: vi.fn(async () => []),
  prefetchYouTubeStreams: vi.fn(),
  getMediaBase: vi.fn(async () => '')
}))

const { usePlayer, applyAudioSettings } = await import('../src/renderer/src/store/player')

function track(id: string, extra: Partial<Track> = {}): Track {
  return {
    id,
    title: `Title ${id}`,
    artist: 'Artist',
    album: 'Album',
    path: `file:///storage/emulated/0/Android/data/com.cyttos.oli/files/${id}.flac`,
    duration: 200,
    codec: 'flac',
    ...extra
  } as Track
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10))
const loads = (): Call[] => calls.filter((c) => c.name === 'loadSource')
const lastToken = (): string => loads().at(-1)!.arg!.token as string
/** The native side reports that audio is flowing for the newest source. */
const nativePlaying = (over: Record<string, unknown> = {}): void =>
  fire('state', {
    token: lastToken(),
    state: 'ready',
    playWhenReady: true,
    isPlaying: true,
    durationMs: 200000,
    positionMs: 0,
    reason: '',
    ...over
  })
const initial = usePlayer.getState()

beforeEach(async () => {
  calls.length = 0
  usePlayer.setState({ ...initial, queue: [], index: -1, current: null, status: 'idle', history: [] })
  await usePlayer.getState().hydrate()
  await settle()
  calls.length = 0
})

describe('player store on the native audio player', () => {
  it('plays a file: native load with its file URI and labels, then play', async () => {
    usePlayer.getState().playTracks([track('a', { bitDepth: 24 }), track('b')], 0, { source: 'library', sourceId: null })
    await settle()
    expect(calls.map((c) => c.name)).toEqual(['setVolume', 'loadSource', 'setMetadata', 'play'])
    expect(loads()[0].arg).toMatchObject({
      url: 'file:///storage/emulated/0/Android/data/com.cyttos.oli/files/a.flac',
      autoplay: false,
      bitDepth: 24
    })
    expect(calls.find((c) => c.name === 'setMetadata')?.arg).toMatchObject({ title: 'Title a', artist: 'Artist', album: 'Album' })
    expect(usePlayer.getState().status).toBe('loading')

    nativePlaying()
    const s = usePlayer.getState()
    expect(s.status).toBe('playing')
    expect(s.duration).toBe(200)
  })

  it('moves to the next song by itself when the native player reaches the end', async () => {
    usePlayer.getState().playTracks([track('a'), track('b')], 0, { source: 'library', sourceId: null })
    await settle()
    nativePlaying()
    fire('state', { token: lastToken(), state: 'ended', playWhenReady: true, isPlaying: false, durationMs: 200000, positionMs: 200000 })
    await settle()
    expect(usePlayer.getState().current?.id).toBe('b')
    expect(loads().at(-1)!.arg!.url).toContain('/b.flac')
  })

  it('lock-screen next and previous change the song', async () => {
    usePlayer.getState().playTracks([track('a'), track('b'), track('c')], 0, { source: 'library', sourceId: null })
    await settle()
    nativePlaying()
    fire('command', { token: lastToken(), command: 'next' })
    await settle()
    expect(usePlayer.getState().current?.id).toBe('b')
    nativePlaying()
    fire('command', { token: lastToken(), command: 'next' })
    await settle()
    expect(usePlayer.getState().current?.id).toBe('c')
  })

  it('an outside pause (headset unplugged, phone call) and resume show in the player', async () => {
    usePlayer.getState().playTracks([track('a'), track('b')], 0, { source: 'library', sourceId: null })
    await settle()
    nativePlaying()
    fire('state', { token: lastToken(), state: 'ready', playWhenReady: false, isPlaying: false, durationMs: 200000, positionMs: 5000, reason: 'audioBecomingNoisy' })
    expect(usePlayer.getState().status).toBe('paused')
    fire('state', { token: lastToken(), state: 'ready', playWhenReady: true, isPlaying: true, durationMs: 200000, positionMs: 5000, reason: 'user' })
    expect(usePlayer.getState().status).toBe('playing')
    expect(usePlayer.getState().current?.id).toBe('a')
  })

  it('the play button pauses and resumes through the native player', async () => {
    usePlayer.getState().playTracks([track('a')], 0, { source: 'library', sourceId: null })
    await settle()
    nativePlaying()
    calls.length = 0
    usePlayer.getState().toggle()
    await settle()
    expect(calls.map((c) => c.name)).toContain('pause')
    expect(usePlayer.getState().status).toBe('paused')
    usePlayer.getState().toggle()
    await settle()
    expect(calls.map((c) => c.name)).toContain('play')
  })

  it('a file the native player cannot open is skipped', async () => {
    usePlayer.getState().playTracks([track('a'), track('b')], 0, { source: 'library', sourceId: null })
    await settle()
    fire('error', { token: lastToken(), code: 4, codeName: 'ERROR_CODE_IO_FILE_NOT_FOUND', message: 'gone' })
    await settle()
    expect(usePlayer.getState().current?.id).toBe('b')
  })

  it('seeking sends the position in milliseconds', async () => {
    usePlayer.getState().playTracks([track('a')], 0, { source: 'library', sourceId: null })
    await settle()
    nativePlaying()
    calls.length = 0
    usePlayer.getState().seek(30.5)
    await settle()
    expect(calls.find((c) => c.name === 'seekTo')?.arg).toEqual({ positionMs: 30500 })
  })

  it('the bit-perfect setting reaches the native player', async () => {
    calls.length = 0
    applyAudioSettings({ bitPerfectOutput: true })
    await settle()
    expect(calls.find((c) => c.name === 'setBitPerfect')?.arg).toEqual({ enabled: true })
  })
})
