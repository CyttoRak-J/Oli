/**
 * Android only: an object that behaves like an <audio> element but plays through the native Media3 player (Capacitor
 * plugin `OliAudio`). The shared player engine (store/player.ts) talks to it exactly as it talks to an audio element,
 * so queue, shuffle, repeat, radio, fallbacks and resume work unchanged, and playback is native-grade: background play
 * with the screen off, lock-screen / notification / headset controls, audio focus, and hi-res output.
 *
 * Nothing here imports Capacitor or the desktop code, so it can be unit-tested with a fake plugin.
 */

/** The parts of an audio element the player engine uses (an HTMLAudioElement satisfies this too). */
export interface AudioLike {
  src: string
  readonly currentSrc: string
  currentTime: number
  readonly duration: number
  volume: number
  muted: boolean
  readonly paused: boolean
  readonly readyState: number
  readonly error: { code: number; message: string } | null
  playbackRate: number
  defaultPlaybackRate: number
  preservesPitch: boolean
  preload: string
  play(): Promise<void>
  pause(): void
  removeAttribute(name: string): void
  addEventListener(type: string, listener: (e: Event) => void): void
  removeEventListener(type: string, listener: (e: Event) => void): void
  /** Native player only: labels for the notification / lock screen. */
  setMetadata?(m: NativeMetadata): void
  /** Native player only: bit-perfect output on a USB DAC (Android 14+). */
  setBitPerfect?(enabled: boolean): Promise<void>
}

export interface NativeMetadata {
  title: string
  artist: string
  album: string
  artworkUri: string
  /** Bit depth of the file when the library knows it (helps the player choose 16-bit or float output). */
  bitDepth?: number
}

/** What really reaches the hardware (see OliAudioEngine.outputInfo in the Android code). */
export interface NativeOutputInfo {
  available: boolean
  androidApi?: number
  hasSource?: boolean
  source?: { container: string; mime: string; sampleRate: number; channels: number; bitDepth: number; bitrate: number }
  decoder?: string
  decoderIsSoftware?: boolean
  floatAllowed?: boolean
  mixerRate?: number
  track?: { ready: boolean; encoding: string; sampleRate: number; channels: number; offload: boolean }
  device?: { type?: string; name?: string; exact?: boolean; bluetooth?: boolean; usb?: boolean; sampleRates?: number[] }
  bitPerfect?: { supported: boolean; requested: boolean; active: boolean; note: string }
  resampled?: boolean
  verdict?: string
  sinkError?: string
  seekNote?: string
}

interface NativeListenerHandle {
  remove(): Promise<void> | void
}

/** The Capacitor plugin as JavaScript sees it. */
export interface OliAudioPlugin {
  loadSource(o: {
    url: string
    headers?: Record<string, string>
    startPositionMs?: number
    autoplay?: boolean
    bitDepth?: number
    token: string
  }): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  stop(): Promise<void>
  seekTo(o: { positionMs: number }): Promise<void>
  setVolume(o: { volume: number }): Promise<void>
  setPlaybackParams(o: { speed: number; preservePitch: boolean }): Promise<void>
  setMetadata(o: { title: string; artist: string; album: string; artworkUri: string }): Promise<void>
  setBitPerfect(o: { enabled: boolean }): Promise<void>
  getOutputInfo(): Promise<NativeOutputInfo>
  addListener(
    event: string,
    cb: (data: never) => void
  ): Promise<NativeListenerHandle> | NativeListenerHandle
}

interface StateEvent {
  token: string
  state: 'idle' | 'buffering' | 'ready' | 'ended'
  playWhenReady: boolean
  isPlaying: boolean
  durationMs: number
  positionMs: number
  reason?: string
}
interface TimeEvent {
  token: string
  positionMs: number
  durationMs: number
  bufferedMs: number
}
interface ErrorEvent2 {
  token: string
  code: number
  codeName?: string
  message?: string
  cause?: string
}

export type NativeCommand = 'next' | 'previous'

// HTMLMediaElement.readyState values.
const HAVE_NOTHING = 0
const HAVE_METADATA = 1
const HAVE_ENOUGH_DATA = 4

/** Request headers some stream addresses need (YouTube wants the User-Agent yt-dlp saw); set by the YouTube service. */
const streamHeaders = new Map<string, Record<string, string>>()
export function setStreamHeaders(url: string, headers: Record<string, string>): void {
  if (Object.keys(headers).length === 0) return
  streamHeaders.set(url, headers)
  // remember only the newest few hundred addresses
  if (streamHeaders.size > 400) streamHeaders.delete(streamHeaders.keys().next().value as string)
}

export class NativeAudio extends EventTarget implements AudioLike {
  preload = 'auto'
  defaultPlaybackRate = 1

  private plugin: OliAudioPlugin
  private _src = ''
  private _currentTime = 0
  private _duration = Number.NaN
  private _volume = 1
  private _muted = false
  private _paused = true
  private _readyState = HAVE_NOTHING
  private _error: { code: number; message: string } | null = null
  private _rate = 1
  private _pitch = true
  private token = ''
  private tokenSeq = 0
  private metadata: NativeMetadata | null = null
  private sentRate = { speed: 1, pitch: true }
  private rateTimer: ReturnType<typeof setTimeout> | null = null
  /** Serialises plugin calls so they reach the native side in the order the player made them. */
  private chain: Promise<unknown> = Promise.resolve()
  private metadataSeen = false
  private waiting = false
  private playing = false
  /** playWhenReady value our own last play() / pause() asked for, until the native side confirms it. */
  private awaiting: boolean | null = null
  private awaitUntil = 0
  /** Position we asked for with currentTime = x, until the native side confirms the seek (older position reports are stale). */
  private seekTarget: number | null = null
  private seekUntil = 0

  constructor(plugin: OliAudioPlugin) {
    super()
    this.plugin = plugin
    void this.listen('state', (d: StateEvent) => this.onState(d))
    void this.listen('time', (d: TimeEvent) => this.onTime(d))
    void this.listen('seeked', (d: { token: string; positionMs: number }) => {
      if (d.token !== this.token) return
      this.seekTarget = null
      this._currentTime = d.positionMs / 1000
      this.emit('seeked')
    })
    void this.listen('error', (d: ErrorEvent2) => this.onError(d))
    void this.listen('command', (d: { command: NativeCommand }) => {
      this.dispatchEvent(new CustomEvent('nativecommand', { detail: d.command }))
    })
    void this.listen('outputChanged', (d: NativeOutputInfo) => {
      this.dispatchEvent(new CustomEvent('nativeoutput', { detail: d }))
    })
  }

  private async listen<T>(event: string, cb: (data: T) => void): Promise<void> {
    try {
      await this.plugin.addListener(event, cb as (data: never) => void)
    } catch {
      // Without events the player still works; it just gets no progress updates.
    }
  }

  /** Runs a plugin call after all earlier ones; failures are returned to the caller, never break the chain. */
  private send<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => undefined)
    return run
  }

  private emit(type: string): void {
    // Asynchronous like the events of a real audio element. A microtask, not a timer: timers are slowed down a lot
    // while the app is minimized.
    void Promise.resolve().then(() => this.dispatchEvent(new Event(type)))
  }

  // --- properties the player engine uses ---------------------------------------------------------------------

  get src(): string {
    return this._src
  }

  set src(url: string) {
    this.loadNew(url)
  }

  get currentSrc(): string {
    return this._src
  }

  get currentTime(): number {
    return this._currentTime
  }

  set currentTime(seconds: number) {
    if (!Number.isFinite(seconds) || seconds < 0) return
    this._currentTime = seconds
    if (!this._src) return
    this.seekTarget = seconds
    this.seekUntil = Date.now() + 2500
    void this.send(() => this.plugin.seekTo({ positionMs: Math.round(seconds * 1000) })).catch(() => undefined)
  }

  get duration(): number {
    return this._duration
  }

  get volume(): number {
    return this._volume
  }

  set volume(v: number) {
    this._volume = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 1))
    this.pushVolume()
  }

  get muted(): boolean {
    return this._muted
  }

  set muted(m: boolean) {
    this._muted = m
    this.pushVolume()
  }

  private pushVolume(): void {
    const volume = this._muted ? 0 : this._volume
    void this.send(() => this.plugin.setVolume({ volume })).catch(() => undefined)
  }

  get paused(): boolean {
    return this._paused
  }

  get readyState(): number {
    return this._readyState
  }

  get error(): { code: number; message: string } | null {
    return this._error
  }

  get playbackRate(): number {
    return this._rate
  }

  set playbackRate(r: number) {
    this._rate = r
    this.scheduleRate()
  }

  get preservesPitch(): boolean {
    return this._pitch
  }

  set preservesPitch(p: boolean) {
    this._pitch = p
    this.scheduleRate()
  }

  /** Speed and pitch arrive as separate assignments: send them once, together. */
  private scheduleRate(): void {
    if (this.rateTimer) return
    this.rateTimer = setTimeout(() => {
      this.rateTimer = null
      if (this.sentRate.speed === this._rate && this.sentRate.pitch === this._pitch) return
      this.sentRate = { speed: this._rate, pitch: this._pitch }
      void this.send(() => this.plugin.setPlaybackParams({ speed: this._rate, preservePitch: this._pitch })).catch(
        () => undefined
      )
    }, 0)
  }

  // --- methods ------------------------------------------------------------------------------------------------

  private newToken(): string {
    this.tokenSeq += 1
    this.token = `t${this.tokenSeq}`
    return this.token
  }

  private resetState(): void {
    this._currentTime = 0
    this._duration = Number.NaN
    this._readyState = HAVE_NOTHING
    this._error = null
    this._paused = true
    this.metadataSeen = false
    this.waiting = false
    this.playing = false
    this.awaiting = null
    this.seekTarget = null
  }

  private loadNew(rawUrl: string): void {
    // A plain path ("/storage/...") is a file; the native player wants a URI.
    const url = rawUrl.startsWith('/') ? `file://${encodeURI(rawUrl)}` : rawUrl
    const token = this.newToken()
    this.resetState()
    this._src = rawUrl
    if (!url) {
      void this.send(() => this.plugin.stop()).catch(() => undefined)
      return
    }
    const md = this.metadata
    void this.send(async () => {
      await this.plugin.loadSource({
        url,
        headers: streamHeaders.get(url),
        autoplay: false,
        bitDepth: md?.bitDepth,
        token
      })
      if (this.token !== token) return
      if (md) {
        await this.plugin.setMetadata({
          title: md.title,
          artist: md.artist,
          album: md.album,
          artworkUri: md.artworkUri
        })
      }
    }).catch((e: unknown) => {
      if (this.token !== token) return
      this.fail({ token, code: 2, message: `native load failed: ${String((e as Error)?.message ?? e)}` })
    })
  }

  play(): Promise<void> {
    if (!this._src) {
      return Promise.reject(new DOMException('The element has no supported sources.', 'NotSupportedError'))
    }
    const wasPaused = this._paused
    // The player failed earlier (a phone call took the audio device, the network dropped) and sits idle: open the same
    // source again at the same place instead of asking an idle player to play.
    const reopen = this._error !== null
    const resumeAt = this._currentTime
    if (reopen) {
      this._error = null
      this._readyState = HAVE_NOTHING
      this.waiting = false
      this.playing = false
    }
    this._paused = false
    this.awaiting = true
    this.awaitUntil = Date.now() + 1500
    if (reopen) {
      const rawUrl = this._src
      const url = rawUrl.startsWith('/') ? `file://${encodeURI(rawUrl)}` : rawUrl
      const token = this.token
      const md = this.metadata
      this.emit('play')
      this.emit('waiting')
      this.waiting = true
      return this.send(async () => {
        await this.plugin.loadSource({
          url,
          headers: streamHeaders.get(url),
          startPositionMs: Math.max(0, Math.round(resumeAt * 1000)),
          autoplay: true,
          bitDepth: md?.bitDepth,
          token
        })
      })
    }
    if (wasPaused) this.emit('play')
    if (this._readyState < HAVE_ENOUGH_DATA && !this.waiting) {
      this.waiting = true
      this.emit('waiting')
    }
    return this.send(() => this.plugin.play())
  }

  pause(): void {
    if (this._paused) return
    this._paused = true
    this.playing = false
    this.awaiting = false
    this.awaitUntil = Date.now() + 1500
    this.emit('pause')
    void this.send(() => this.plugin.pause()).catch(() => undefined)
  }

  removeAttribute(name: string): void {
    if (name !== 'src') return
    this.newToken()
    this.resetState()
    this._src = ''
    void this.send(() => this.plugin.stop()).catch(() => undefined)
  }

  setMetadata(m: NativeMetadata): void {
    this.metadata = m
    if (!this._src) return
    const token = this.token
    void this.send(async () => {
      if (this.token !== token) return
      await this.plugin.setMetadata({ title: m.title, artist: m.artist, album: m.album, artworkUri: m.artworkUri })
    }).catch(() => undefined)
  }

  /** Turns bit-perfect output (USB DAC, Android 14+) on or off. */
  setBitPerfect(enabled: boolean): Promise<void> {
    return this.send(() => this.plugin.setBitPerfect({ enabled }))
  }

  getOutputInfo(): Promise<NativeOutputInfo> {
    return this.send(() => this.plugin.getOutputInfo())
  }

  // --- events from the native player ------------------------------------------------------------------------

  /** True while a seek we asked for is on its way: position reports from before it would make the bar jump back. */
  private staleAfterSeek(positionMs: number): boolean {
    if (this.seekTarget === null) return false
    if (Date.now() > this.seekUntil || Math.abs(positionMs / 1000 - this.seekTarget) < 1.5) {
      this.seekTarget = null
      return false
    }
    return true
  }

  private onTime(d: TimeEvent): void {
    if (d.token !== this.token) return
    if (d.durationMs > 0) this._duration = d.durationMs / 1000
    if (this.staleAfterSeek(d.positionMs)) return
    this._currentTime = d.positionMs / 1000
    this.dispatchEvent(new Event('timeupdate'))
  }

  private onState(d: StateEvent): void {
    if (d.token !== this.token || !this._src) return
    if (d.durationMs > 0) this._duration = d.durationMs / 1000

    if (d.state === 'ready') {
      this._readyState = HAVE_ENOUGH_DATA
      if (!this.metadataSeen) {
        this.metadataSeen = true
        this.dispatchEvent(new Event('loadedmetadata'))
      }
    } else if (d.state === 'buffering') {
      if (this._readyState > HAVE_METADATA) this._readyState = HAVE_METADATA
    }

    if (d.state === 'ended') {
      this._currentTime = this._duration > 0 ? this._duration : this._currentTime
      if (!this._paused) {
        this._paused = true
        this.playing = false
        this.dispatchEvent(new Event('pause'))
      }
      this.dispatchEvent(new Event('ended'))
      return
    }

    // Pause / resume that came from outside (notification button, headset, audio focus): mirror it like an element.
    // While a play() / pause() of our own is still on its way to the native side, older events must not undo it.
    if (this.awaiting !== null) {
      if (d.playWhenReady === this.awaiting || Date.now() > this.awaitUntil) this.awaiting = null
    }
    if (d.state !== 'idle' && this.awaiting === null) {
      if (!d.playWhenReady && !this._paused) {
        this._paused = true
        this.playing = false
        this.dispatchEvent(new Event('pause'))
      } else if (d.playWhenReady && this._paused) {
        this._paused = false
        this.dispatchEvent(new Event('play'))
      }
    }

    if (d.isPlaying && !this._paused) {
      if (!this.playing) {
        this.playing = true
        this.waiting = false
        this.dispatchEvent(new Event('playing'))
      }
    } else if (!this._paused && d.playWhenReady && d.state === 'buffering') {
      this.playing = false
      if (!this.waiting) {
        this.waiting = true
        this.dispatchEvent(new Event('waiting'))
      }
    }
  }

  private onError(d: ErrorEvent2): void {
    if (d.token !== this.token) return
    this.fail(d)
  }

  private fail(d: { token: string; code: number; message?: string; codeName?: string; cause?: string }): void {
    const detail = [d.codeName, d.message, d.cause].filter(Boolean).join(': ')
    this._error = { code: d.code, message: detail || 'native playback error' }
    this._readyState = HAVE_NOTHING
    this.playing = false
    this.dispatchEvent(new Event('error'))
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Access from the app

let instance: NativeAudio | null = null

interface CapacitorGlobal {
  getPlatform?: () => string
  registerPlugin?: <T>(name: string) => T
  PluginHeaders?: Array<{ name: string }>
}

let pluginProxy: OliAudioPlugin | null = null

/** The native plugin, or null when this is not the Android app (or the APK has no OliAudio plugin). */
export function getNativePlugin(): OliAudioPlugin | null {
  // The desktop build replaces __OLI_WEB__ with false, which removes the rest of this file's phone code from it.
  if (typeof __OLI_WEB__ !== 'undefined' && !__OLI_WEB__) return null
  if (pluginProxy) return pluginProxy
  if (typeof window === 'undefined') return null
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor
  if (!cap || cap.getPlatform?.() !== 'android' || !cap.registerPlugin) return null
  // Capacitor lists the native plugins it knows in PluginHeaders (registered by MainActivity).
  if (Array.isArray(cap.PluginHeaders) && !cap.PluginHeaders.some((h) => h.name === 'OliAudio')) return null
  // registerPlugin may only be called once per name.
  pluginProxy = cap.registerPlugin<OliAudioPlugin>('OliAudio')
  return pluginProxy
}

/** The one NativeAudio of the app (null on desktop, in a browser, or when the plugin is missing). */
export function getNativeAudio(): NativeAudio | null {
  if (typeof __OLI_WEB__ !== 'undefined' && !__OLI_WEB__) return null // desktop build: this whole file drops out
  if (instance) return instance
  const plugin = getNativePlugin()
  if (!plugin) return null
  instance = new NativeAudio(plugin)
  return instance
}
