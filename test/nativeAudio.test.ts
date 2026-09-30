import { describe, expect, it } from 'vitest'
import { NativeAudio, type NativeOutputInfo, type OliAudioPlugin } from '../src/renderer/src/platform/nativeAudio'
import { describeOutput, outputRows } from '../src/renderer/src/lib/outputText'

/** A stand-in for the Android plugin: records every call and lets a test fire native events. */
function fakePlugin(): {
  plugin: OliAudioPlugin
  calls: Array<{ name: string; arg?: unknown }>
  fire: (event: string, data: unknown) => void
  failNext: (name: string) => void
} {
  const calls: Array<{ name: string; arg?: unknown }> = []
  const listeners = new Map<string, Array<(d: unknown) => void>>()
  const failing = new Set<string>()
  const call =
    (name: string) =>
    async (arg?: unknown): Promise<void> => {
      calls.push({ name, arg })
      if (failing.delete(name)) throw new Error(`${name} failed`)
    }
  const plugin = {
    loadSource: call('loadSource'),
    play: call('play'),
    pause: call('pause'),
    stop: call('stop'),
    seekTo: call('seekTo'),
    setVolume: call('setVolume'),
    setPlaybackParams: call('setPlaybackParams'),
    setMetadata: call('setMetadata'),
    setBitPerfect: call('setBitPerfect'),
    getOutputInfo: async () => ({ available: true }) as NativeOutputInfo,
    addListener: async (event: string, cb: (d: never) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), cb as (d: unknown) => void])
      return { remove: async () => undefined }
    }
  } as unknown as OliAudioPlugin
  return {
    plugin,
    calls,
    fire: (event, data) => (listeners.get(event) ?? []).forEach((cb) => cb(data)),
    failNext: (name) => failing.add(name)
  }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

function setup(): ReturnType<typeof fakePlugin> & { audio: NativeAudio; events: string[]; token: () => string } {
  const fp = fakePlugin()
  const audio = new NativeAudio(fp.plugin)
  const events: string[] = []
  for (const t of ['loadedmetadata', 'play', 'playing', 'pause', 'waiting', 'seeked', 'timeupdate', 'ended', 'error']) {
    audio.addEventListener(t, () => events.push(t))
  }
  const token = (): string => {
    const load = [...fp.calls].reverse().find((c) => c.name === 'loadSource')
    return (load?.arg as { token: string }).token
  }
  return { ...fp, audio, events, token }
}

const state = (token: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  token,
  state: 'ready',
  playWhenReady: true,
  isPlaying: true,
  durationMs: 200000,
  positionMs: 0,
  reason: '',
  ...over
})

describe('NativeAudio', () => {
  it('loads a source without autoplay and starts paused', async () => {
    const { audio, calls, token } = setup()
    audio.src = 'file:///music/a.flac'
    await settle()
    expect(calls.map((c) => c.name)).toEqual(['loadSource'])
    expect(calls[0].arg).toMatchObject({ url: 'file:///music/a.flac', autoplay: false })
    expect(audio.paused).toBe(true)
    expect(audio.readyState).toBe(0)
    expect(audio.currentSrc).toBe('file:///music/a.flac')
    expect(token()).toMatch(/^t\d+$/)
  })

  it('turns a plain path into a file URI for the native player', async () => {
    const { audio, calls } = setup()
    audio.src = '/storage/emulated/0/My Music/a.flac'
    await settle()
    expect((calls[0].arg as { url: string }).url).toBe('file:///storage/emulated/0/My%20Music/a.flac')
  })

  it('play() sends play after the load and reports play + waiting until audio flows', async () => {
    const { audio, calls, events, fire, token } = setup()
    audio.src = 'file:///a.flac'
    await audio.play()
    await settle()
    expect(calls.map((c) => c.name)).toEqual(['loadSource', 'play'])
    expect(events).toEqual(['play', 'waiting'])
    expect(audio.paused).toBe(false)

    fire('state', state(token(), { isPlaying: false, state: 'buffering' }))
    fire('state', state(token()))
    expect(events).toEqual(['play', 'waiting', 'loadedmetadata', 'playing'])
    expect(audio.duration).toBe(200)
    expect(audio.readyState).toBe(4)
  })

  it('rejects play() without a source', async () => {
    const { audio } = setup()
    await expect(audio.play()).rejects.toThrow()
  })

  it('follows time updates and ignores events of an older source', async () => {
    const { audio, events, fire, token } = setup()
    audio.src = 'file:///a.flac'
    await settle()
    const old = token()
    fire('time', { token: old, positionMs: 12500, durationMs: 200000, bufferedMs: 0 })
    expect(audio.currentTime).toBe(12.5)
    expect(events).toContain('timeupdate')

    audio.src = 'file:///b.flac'
    await settle()
    fire('time', { token: old, positionMs: 99000, durationMs: 1, bufferedMs: 0 })
    expect(audio.currentTime).toBe(0)
    expect(audio.duration).toBeNaN()
  })

  it('seeks natively when currentTime is set and reports the seek', async () => {
    const { audio, calls, events, fire, token } = setup()
    audio.src = 'file:///a.flac'
    await settle()
    audio.currentTime = 42.25
    await settle()
    expect(calls.at(-1)).toEqual({ name: 'seekTo', arg: { positionMs: 42250 } })
    expect(audio.currentTime).toBe(42.25)
    fire('seeked', { token: token(), positionMs: 42250 })
    await settle()
    expect(events).toContain('seeked')
  })

  it('a position report from before a seek does not pull the bar back', async () => {
    const { audio, fire, token } = setup()
    audio.src = 'file:///a.flac'
    await settle()
    fire('time', { token: token(), positionMs: 90000, durationMs: 200000, bufferedMs: 0 })
    audio.currentTime = 0 // "previous" / seek to the start
    fire('time', { token: token(), positionMs: 90250, durationMs: 200000, bufferedMs: 0 }) // sent before the seek landed
    expect(audio.currentTime).toBe(0)
    fire('time', { token: token(), positionMs: 300, durationMs: 200000, bufferedMs: 0 }) // after it landed
    expect(audio.currentTime).toBeCloseTo(0.3)
  })

  it('pause() is not undone by an older "playing" event, but a later outside resume is mirrored', async () => {
    const { audio, calls, events, fire, token } = setup()
    audio.src = 'file:///a.flac'
    await audio.play()
    fire('state', state(token()))
    await settle()
    events.length = 0

    audio.pause()
    await settle()
    expect(calls.at(-1)?.name).toBe('pause')
    expect(events).toEqual(['pause'])
    // A stale event that still says "playing" must not flip the element back.
    fire('state', state(token()))
    expect(audio.paused).toBe(true)
    // Native confirms the pause, then the notification Play button resumes.
    fire('state', state(token(), { playWhenReady: false, isPlaying: false }))
    fire('state', state(token(), { playWhenReady: true, isPlaying: true, reason: 'user' }))
    expect(audio.paused).toBe(false)
    expect(events).toEqual(['pause', 'play', 'playing'])
  })

  it('mirrors a pause from outside (headset unplugged, audio focus lost)', async () => {
    const { audio, events, fire, token } = setup()
    audio.src = 'file:///a.flac'
    await audio.play()
    fire('state', state(token()))
    await settle()
    events.length = 0
    fire('state', state(token(), { playWhenReady: false, isPlaying: false, reason: 'audioBecomingNoisy' }))
    expect(audio.paused).toBe(true)
    expect(events).toEqual(['pause'])
  })

  it('ends like an element: pause, then ended', async () => {
    const { audio, events, fire, token } = setup()
    audio.src = 'file:///a.flac'
    await audio.play()
    fire('state', state(token()))
    await settle()
    events.length = 0
    fire('state', state(token(), { state: 'ended', isPlaying: false, positionMs: 200000 }))
    expect(events).toEqual(['pause', 'ended'])
    expect(audio.currentTime).toBe(200)
  })

  it('maps native errors to an element-style error', async () => {
    const { audio, events, fire, token } = setup()
    audio.src = 'file:///a.flac'
    await settle()
    fire('error', { token: token(), code: 4, codeName: 'ERROR_CODE_IO_FILE_NOT_FOUND', message: 'nope' })
    expect(audio.error?.code).toBe(4)
    expect(audio.error?.message).toContain('nope')
    expect(events).toEqual(['error'])
    // A new source clears the error.
    audio.src = 'file:///b.flac'
    expect(audio.error).toBeNull()
  })

  it('play() after an error opens the same song again at the same place (the phone call took the audio device)', async () => {
    const { audio, calls, fire, token, events } = setup()
    audio.src = 'file:///a.flac'
    await settle()
    await audio.play()
    fire('state', state(token()))
    fire('time', { token: token(), positionMs: 83000, durationMs: 200000, bufferedMs: 0 })
    fire('error', { token: token(), code: 3, codeName: 'ERROR_CODE_AUDIO_TRACK_INIT_FAILED', message: 'AudioTrack init failed' })
    expect(audio.error).not.toBeNull()
    calls.length = 0
    events.length = 0
    await audio.play()
    await settle()
    // not a plain play() to an idle player: the source is loaded again, from 83 s, playing
    expect(calls.map((c) => c.name)).toEqual(['loadSource'])
    expect(calls[0].arg).toMatchObject({ url: 'file:///a.flac', startPositionMs: 83000, autoplay: true, token: token() })
    expect(audio.error).toBeNull()
    fire('state', state(token(), { positionMs: 83000 }))
    expect(audio.paused).toBe(false)
  })

  it('reports an error when the native load itself fails', async () => {
    const { audio, events, failNext } = setup()
    failNext('loadSource')
    audio.src = 'file:///a.flac'
    await settle()
    expect(events).toEqual(['error'])
    expect(audio.error?.code).toBe(2)
  })

  it('removeAttribute("src") stops the native player and empties the element', async () => {
    const { audio, calls } = setup()
    audio.src = 'file:///a.flac'
    await audio.play()
    audio.removeAttribute('src')
    await settle()
    expect(calls.at(-1)?.name).toBe('stop')
    expect(audio.src).toBe('')
    expect(audio.paused).toBe(true)
    expect(audio.duration).toBeNaN()
  })

  it('sends volume (muted = 0) and one combined speed/pitch update', async () => {
    const { audio, calls } = setup()
    audio.volume = 0.5
    audio.muted = true
    audio.defaultPlaybackRate = 1.25
    audio.playbackRate = 1.25
    audio.preservesPitch = false
    await settle()
    expect(calls.filter((c) => c.name === 'setVolume').map((c) => c.arg)).toEqual([{ volume: 0.5 }, { volume: 0 }])
    expect(calls.filter((c) => c.name === 'setPlaybackParams').map((c) => c.arg)).toEqual([
      { speed: 1.25, preservePitch: false }
    ])
  })

  it('passes lock-screen next / previous on as a nativecommand event', () => {
    const { audio, fire } = setup()
    const seen: string[] = []
    audio.addEventListener('nativecommand', (e) => seen.push((e as CustomEvent<string>).detail))
    fire('command', { command: 'next' })
    fire('command', { command: 'previous' })
    expect(seen).toEqual(['next', 'previous'])
  })

  it('sends the notification labels after the source is loaded, also when set before it', async () => {
    const { audio, calls } = setup()
    audio.setMetadata({ title: 'T', artist: 'A', album: 'B', artworkUri: '', bitDepth: 24 })
    audio.src = 'file:///a.flac'
    await settle()
    expect(calls.map((c) => c.name)).toEqual(['loadSource', 'setMetadata'])
    expect(calls[0].arg).toMatchObject({ bitDepth: 24 })
    expect(calls[1].arg).toMatchObject({ title: 'T', artist: 'A', album: 'B' })
  })
})

describe('describeOutput / outputRows', () => {
  const base: NativeOutputInfo = {
    available: true,
    mixerRate: 48000,
    track: { ready: true, encoding: 'PCM float (32-bit)', sampleRate: 96000, channels: 2, offload: false },
    device: { type: 'Phone speaker', exact: true },
    bitPerfect: { supported: true, requested: false, active: false, note: 'off' },
    resampled: true
  }

  it('is silent until the output exists', () => {
    expect(describeOutput(null).kind).toBe('idle')
    expect(describeOutput({ available: true, track: { ...base.track!, ready: false } }).text).toBe('')
  })

  it('says when Android converts the rate', () => {
    expect(describeOutput(base)).toEqual({ text: '→ 48 kHz out', kind: 'converted' })
  })

  it('claims bit-perfect only when the report says it is active', () => {
    const bp = { ...base, bitPerfect: { ...base.bitPerfect!, requested: true, active: true }, resampled: false }
    expect(describeOutput(bp)).toEqual({ text: 'bit-perfect 96 kHz', kind: 'bitperfect' })
    const asked = { ...base, bitPerfect: { ...base.bitPerfect!, requested: true, active: false } }
    expect(describeOutput(asked).kind).not.toBe('bitperfect')
  })

  it('warns about Bluetooth and lists the facts', () => {
    const bt = { ...base, device: { type: 'Bluetooth (A2DP)', bluetooth: true } }
    expect(describeOutput(bt).kind).toBe('lossy')
    const rows = outputRows({ ...base, decoder: 'c2.android.flac.decoder', decoderIsSoftware: true })
    expect(rows.find(([k]) => k === 'Decoder')?.[1]).toContain('software')
    expect(rows.find(([k]) => k === 'Bit-perfect')?.[1]).toBe('no (switch is off)')
    expect(rows.find(([k]) => k === 'Output device')?.[1]).toBe('Phone speaker — best guess'.replace(' — best guess', ''))
  })
})
