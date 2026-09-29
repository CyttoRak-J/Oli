/* global window, Audio */
// Throwaway test preload: makes the page believe it runs inside the Android app (Capacitor native bridge) and answers
// the OliAudio plugin calls the way the Java plugin would, playing real audio through an <audio> element.
// Runs in the page's own world (contextIsolation: false). NOT part of the app.
const fs = require('fs')
const path = require('path')

const BASE = 'http://127.0.0.1:8765'
const METHODS = [
  'loadSource', 'play', 'pause', 'stop', 'seekTo', 'setVolume', 'setPlaybackParams', 'setMetadata', 'setBitPerfect', 'getOutputInfo'
]

window.WEBVIEW_SERVER_URL = BASE
window.Capacitor = {
  DEBUG: false,
  isLoggingEnabled: false,
  PluginHeaders: [
    { name: 'OliAudio', methods: [...METHODS.map((name) => ({ name, rtype: 'promise' })), { name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'promise' }] }
  ]
}
window.androidBridge = { postMessage: (s) => handle(JSON.parse(s)), onmessage: null }

// Load Capacitor's real native bridge script (from the installed package) so the page uses its real call/notify path.
const bridgeJs = fs.readFileSync(
  path.join(__dirname, '..', '..', 'node_modules', '@capacitor', 'android', 'capacitor', 'src', 'main', 'assets', 'native-bridge.js'),
  'utf8'
)
;(0, eval)(bridgeJs)

const fake = (window.__fakeNative = { calls: [], events: [], audio: new Audio(), token: '', playWhenReady: false, listeners: {}, meta: null, bitPerfect: false })
const audio = fake.audio
audio.preload = 'auto'

function reply(callbackId, methodName, data, success = true, save) {
  const msg = { callbackId, pluginId: 'OliAudio', methodName, success, data }
  if (save !== undefined) msg.save = save
  setTimeout(() => window.androidBridge.onmessage({ data: JSON.stringify(msg) }), 0)
}
function emit(name, data) {
  const id = fake.listeners[name]
  fake.events.push({ name, t: Date.now(), data })
  if (id) reply(id, 'addListener', { token: fake.token, ...data }, true, true)
}
const mapUrl = (u) => {
  if (u.startsWith('file://')) return `${BASE}/file/${u.slice('file:///'.length)}`
  return u
}
const dur = () => (Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : -1)
function state(reason = '') {
  const ready = audio.readyState >= 3
  const ended = audio.ended
  emit('state', {
    state: !audio.src ? 'idle' : ended ? 'ended' : ready ? 'ready' : 'buffering',
    playWhenReady: fake.playWhenReady,
    isPlaying: !audio.paused && ready && !ended,
    suppressed: false,
    reason,
    durationMs: dur(),
    positionMs: Math.round(audio.currentTime * 1000)
  })
}
for (const ev of ['loadedmetadata', 'canplay', 'waiting', 'playing', 'pause', 'ended']) audio.addEventListener(ev, () => state())
audio.addEventListener('seeked', () => emit('seeked', { positionMs: Math.round(audio.currentTime * 1000) }))
audio.addEventListener('error', () => {
  const code = audio.error ? audio.error.code : 0
  emit('error', { code: code === 2 ? 2 : 4, codeName: 'FAKE_' + code, message: audio.error ? audio.error.message : '' })
})
setInterval(() => {
  if (!audio.paused && audio.src) emit('time', { positionMs: Math.round(audio.currentTime * 1000), durationMs: dur(), bufferedMs: 0 })
}, 250)

// Buttons of the lock screen / a headset, for the driver.
fake.command = (c) => emit('command', { command: c })
fake.outsidePause = (reason = 'audioBecomingNoisy') => {
  fake.playWhenReady = false
  audio.pause()
  state(reason)
}
fake.outsideResume = () => {
  fake.playWhenReady = true
  audio.play()
  state('user')
}

let pendingStart = 0
function handle(m) {
  if (m.type === 'js.error' || m.pluginId !== 'OliAudio') {
    if (m.callbackId && m.callbackId !== '-1' && m.pluginId) {
      // Other plugins (Filesystem, ...) are not part of this test.
      setTimeout(() => window.androidBridge.onmessage({ data: JSON.stringify({ callbackId: m.callbackId, pluginId: m.pluginId, methodName: m.methodName, success: false, error: { message: 'not in harness', code: 'UNIMPLEMENTED' } }) }), 0)
    }
    return
  }
  const o = m.options || {}
  if (m.methodName === 'addListener') {
    fake.listeners[o.eventName] = m.callbackId
    return
  }
  fake.calls.push({ t: Date.now(), name: m.methodName, arg: o })
  let data = {}
  switch (m.methodName) {
    case 'loadSource':
      fake.token = o.token
      fake.playWhenReady = !!o.autoplay
      pendingStart = o.startPositionMs || 0
      audio.src = mapUrl(o.url)
      audio.load()
      if (o.autoplay) audio.play().catch(() => {})
      state()
      break
    case 'play':
      fake.playWhenReady = true
      audio.play().catch(() => {})
      state('user')
      break
    case 'pause':
      fake.playWhenReady = false
      audio.pause()
      state('user')
      break
    case 'stop':
      fake.playWhenReady = false
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      state()
      break
    case 'seekTo':
      audio.currentTime = (o.positionMs || 0) / 1000
      break
    case 'setVolume':
      audio.volume = o.volume
      break
    case 'setPlaybackParams':
      audio.playbackRate = o.speed
      audio.preservesPitch = !!o.preservePitch
      break
    case 'setMetadata':
      fake.meta = o
      break
    case 'setBitPerfect':
      fake.bitPerfect = !!o.enabled
      break
    case 'getOutputInfo':
      data = {
        available: true,
        androidApi: 34,
        hasSource: !!audio.src,
        source: { container: 'flac', mime: 'audio/flac', sampleRate: 96000, channels: 2, bitDepth: 24, bitrate: 0 },
        decoder: 'c2.android.flac.decoder (FAKE harness)',
        decoderIsSoftware: true,
        floatAllowed: true,
        mixerRate: 48000,
        track: { ready: !!audio.src && audio.readyState >= 3, encoding: 'PCM float (32-bit)', sampleRate: 96000, channels: 2, offload: false },
        device: { type: 'Phone speaker', name: 'FAKE', exact: true, bluetooth: false, usb: false, sampleRates: [] },
        bitPerfect: { supported: true, requested: fake.bitPerfect, active: false, note: fake.bitPerfect ? 'FAKE: no bit-perfect mode on speaker' : 'off' },
        resampled: true,
        verdict: "Android's mixer converts 96000 Hz to 48000 Hz before the sound goes out. (harness data)"
      }
      break
  }
  reply(m.callbackId, m.methodName, data)
}
audio.addEventListener('loadedmetadata', () => {
  if (pendingStart > 0) {
    audio.currentTime = pendingStart / 1000
    pendingStart = 0
  }
})
