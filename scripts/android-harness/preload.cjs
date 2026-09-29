/* global window, Audio */
// Throwaway test preload: makes the page believe it runs inside the Android app (Capacitor native bridge) and answers
// the OliAudio plugin calls the way the Java plugin would, playing real audio through an <audio> element.
// Runs in the page's own world (contextIsolation: false). NOT part of the app.
const fs = require('fs')
const path = require('path')

const BASE = 'http://127.0.0.1:8765'
const MEDIA_METHODS = ['getPermission', 'requestPermission', 'queryAudio', 'probeFiles', 'getArtwork', 'clearArtworkCache']
const FLAC_DIR = 'A:/Flac'
const DL_METHODS = ['getRoot', 'enqueue', 'pause', 'resume', 'cancel', 'getActive', 'writeTags']
const FS_METHODS = ['readdir', 'writeFile', 'readFile', 'deleteFile', 'getUri', 'stat', 'mkdir']
const ART_DIR = require('path').join(require('os').tmpdir(), 'oli-harness-art')
const METHODS = [
  'loadSource', 'play', 'pause', 'stop', 'seekTo', 'setVolume', 'setPlaybackParams', 'setMetadata', 'setBitPerfect', 'getOutputInfo'
]

window.WEBVIEW_SERVER_URL = BASE
window.Capacitor = {
  DEBUG: false,
  isLoggingEnabled: false,
  PluginHeaders: [
    { name: 'OliAudio', methods: [...METHODS.map((name) => ({ name, rtype: 'promise' })), { name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'promise' }] },
    { name: 'OliMedia', methods: [...MEDIA_METHODS.map((name) => ({ name, rtype: 'promise' })), { name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'promise' }] },
    { name: 'OliDownload', methods: [...DL_METHODS.map((name) => ({ name, rtype: 'promise' })), { name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'promise' }] },
    { name: 'Filesystem', methods: FS_METHODS.map((name) => ({ name, rtype: 'promise' })) },
    { name: 'Share', methods: ['share', 'canShare'].map((name) => ({ name, rtype: 'promise' })) }
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
const stubs = require('./stubs-downloads.cjs')({ BASE, FLAC_DIR })

function handle(m) {
  if (m.pluginId === 'OliMedia') return handleMedia(m)
  if (m.pluginId === 'OliDownload') return stubs.handleDownload(m)
  if (m.pluginId === 'Filesystem') return stubs.handleFs(m)
  if (m.pluginId === 'Share') return stubs.handleShare(m)
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


// ---------------------------------------------------------------- stand-in for the OliMedia plugin (MediaStore)
// Lists the first songs of A:\Flac as if MediaStore knew them, reads the real FLAC header for probeFiles, and hands out
// a generated cover for albums whose name starts with "A".
const media = (window.__fakeMedia = { calls: [], granted: process.env.OLI_HARNESS_DENY !== '1', files: null, listeners: {} })
function listFiles() {
  if (media.files) return media.files
  const names = fs.readdirSync(FLAC_DIR).filter((n) => n.toLowerCase().endsWith('.flac')).sort().slice(0, 60)
  media.files = names.map((name, i) => {
    const st = fs.statSync(path.join(FLAC_DIR, name))
    const stem = name.replace(/\.flac$/i, '')
    const dash = stem.indexOf(' - ')
    return {
      id: 1000 + i,
      uri: 'file:///' + FLAC_DIR + '/' + name,
      title: dash > 0 ? stem.slice(0, dash) : stem,
      artist: dash > 0 ? stem.slice(dash + 3).split(',')[0].trim() : '<unknown>',
      album: 'Harness album ' + 'ABC'[i % 3],
      albumArtist: '',
      composer: '',
      genre: '',
      year: 2015,
      trackNo: i + 1,
      discNo: 0,
      durationMs: 0,
      size: st.size,
      modifiedSec: Math.floor(st.mtimeMs / 1000),
      addedSec: Math.floor(st.mtimeMs / 1000),
      displayName: name,
      mime: 'audio/flac',
      bitrate: 0,
      key: 'Music/' + name
    }
  })
  return media.files
}
function flacInfo(file) {
  const fd = fs.openSync(file, 'r')
  const b = Buffer.alloc(64)
  fs.readSync(fd, b, 0, 64, 0)
  fs.closeSync(fd)
  if (b.toString('latin1', 0, 4) !== 'fLaC') return {}
  const rate = (b[18] << 12) | (b[19] << 4) | (b[20] >> 4)
  const ch = ((b[20] >> 1) & 7) + 1
  const bps = (((b[20] & 1) << 4) | (b[21] >> 4)) + 1
  return { sampleRate: rate, channels: ch, bitDepth: bps, container: 'flac' }
}
function mediaReply(m, data, success = true, error) {
  const msg = { callbackId: m.callbackId, pluginId: 'OliMedia', methodName: m.methodName, success, data }
  if (error) msg.error = { message: error }
  setTimeout(() => window.androidBridge.onmessage({ data: JSON.stringify(msg) }), 0)
}
function handleMedia(m) {
  const o = m.options || {}
  if (m.methodName === 'addListener') {
    media.listeners[o.eventName] = m.callbackId
    return
  }
  media.calls.push({ name: m.methodName, arg: o })
  switch (m.methodName) {
    case 'getPermission':
      return mediaReply(m, { granted: media.granted })
    case 'requestPermission':
      return mediaReply(m, { granted: media.granted })
    case 'queryAudio': {
      if (!media.granted) return mediaReply(m, undefined, false, 'permission')
      const all = listFiles()
      return mediaReply(m, { rows: all.slice(o.offset || 0, (o.offset || 0) + (o.limit || 500)), total: all.length })
    }
    case 'probeFiles':
      return mediaReply(m, {
        results: (o.uris || []).map((uri) => {
          try {
            return { uri, ...flacInfo(decodeURIComponent(uri.replace('file:///', ''))) }
          } catch (e) {
            return { uri, error: String(e) }
          }
        })
      })
    case 'getArtwork': {
      if (!String(o.key).startsWith('album:')) return mediaReply(m, {})
      // only some albums have a cover: decided by the key's last hex digit
      if (parseInt(String(o.key).slice(-1), 16) % 2 === 1) return mediaReply(m, {})
      fs.mkdirSync(ART_DIR, { recursive: true })
      const file = ART_DIR + '/' + String(o.key).replace(/[^A-Za-z0-9]/g, '_') + '.svg'
      fs.writeFileSync(file, '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#c026d3"/></svg>')
      // a device path starts with '/' (Windows paths need one added so file:// + path works like on the phone)
      return mediaReply(m, { path: file.startsWith('/') ? file : '/' + file })
    }
    default:
      return mediaReply(m, {})
  }
}
media.changed = () => {
  const id = media.listeners.mediaChanged
  if (id) window.androidBridge.onmessage({ data: JSON.stringify({ callbackId: id, pluginId: 'OliMedia', methodName: 'addListener', success: true, save: true, data: {} }) })
}
