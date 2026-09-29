/* global window */
// Stand-in for the OliYouTube plugin in the PC test window. yt-dlp itself is not run: search, playlist and video
// descriptions are answered with REAL yt-dlp output saved in test/fixtures/yt (stream addresses are replaced by a local
// song so the player has something to play), and downloads copy a local FLAC into the app folder with progress events.
// The Java side and yt-dlp on the phone are NOT exercised here (see HANDOFF.md).
const fs = require('fs')
const path = require('path')
const os = require('os')

module.exports = function install({ BASE, FLAC_DIR, FIXTURES }) {
  const FILES_ROOT = path.join(os.tmpdir(), 'oli-harness-files')
  const yt = (window.__fakeYt = { calls: [], tasks: {}, known: {}, listeners: {}, engine: { version: '2026.08.19', latest: '2026.09.20' }, failStreams: false })
  const read = (n) => fs.readFileSync(path.join(FIXTURES, n), 'utf8')
  const post = (msg) => setTimeout(() => window.androidBridge.onmessage({ data: JSON.stringify(msg) }), 0)
  const emit = (name, data) => {
    const id = yt.listeners[name]
    if (id) window.androidBridge.onmessage({ data: JSON.stringify({ callbackId: id, pluginId: 'OliYouTube', methodName: 'addListener', success: true, save: true, data }) })
  }
  const reply = (m, data, success = true, error) => {
    const msg = { callbackId: m.callbackId, pluginId: 'OliYouTube', methodName: m.methodName, success, data }
    if (error) msg.error = { message: error }
    post(msg)
  }

  // a small local song that stands in for a downloaded / streamed track
  const songs = fs
    .readdirSync(FLAC_DIR)
    .filter((n) => n.toLowerCase().endsWith('.flac'))
    .map((n) => ({ n, s: fs.statSync(path.join(FLAC_DIR, n)).size }))
    .filter((x) => x.s < 12e6)
    .sort((a, b) => a.s - b.s)
  const localSong = songs[0].n

  function streamJson() {
    const d = JSON.parse(read('stream.json'))
    const url = BASE + '/file/' + FLAC_DIR + '/' + encodeURIComponent(localSong) + '?expire=' + (Math.floor(Date.now() / 1000) + 6 * 3600)
    d.formats = [
      { format_id: '140', ext: 'm4a', acodec: 'mp4a.40.2', vcodec: 'none', abr: 129, url, http_headers: { 'User-Agent': 'Harness-UA/1.0', Cookie: 'must-not-reach-the-player' } },
      ...d.formats.filter((f) => f.vcodec !== 'none')
    ]
    return JSON.stringify(d)
  }

  function runTask(t) {
    const dest = path.join(FILES_ROOT, t.relBase + '.flac')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const src = path.join(FLAC_DIR, localSong)
    const total = fs.statSync(src).size
    emit('dlState', { id: t.id, state: 'downloading', bytes: 0 })
    let done = 0
    const fd = fs.openSync(src, 'r')
    const out = fs.openSync(dest + '.part', 'w')
    const step = () => {
      if (t.cancel) {
        fs.closeSync(fd)
        fs.closeSync(out)
        try { fs.unlinkSync(dest + '.part') } catch (e) { /* none */ }
        delete yt.tasks[t.id]
        return emit('dlState', { id: t.id, state: 'canceled' })
      }
      if (t.pause) {
        fs.closeSync(fd)
        fs.closeSync(out)
        delete yt.tasks[t.id]
        return emit('dlState', { id: t.id, state: 'paused', bytes: done })
      }
      const buf = Buffer.alloc(256 * 1024)
      const n = fs.readSync(fd, buf, 0, buf.length, done)
      if (n > 0) {
        fs.writeSync(out, buf, 0, n)
        done += n
        emit('dlProgress', { id: t.id, bytes: done, total, speed: 2000000 })
        return setTimeout(step, yt.throttleMs || 60)
      }
      fs.closeSync(fd)
      fs.closeSync(out)
      fs.renameSync(dest + '.part', dest)
      delete yt.tasks[t.id]
      emit('dlState', { id: t.id, state: 'completed', path: 'file:///' + dest.replace(/\\/g, '/'), size: total, md5: '', tagged: true, tagNote: '' })
    }
    step()
  }

  function handle(m) {
    const o = m.options || {}
    if (m.methodName === 'addListener') {
      yt.listeners[o.eventName] = m.callbackId
      return
    }
    yt.calls.push({ name: m.methodName, arg: o })
    switch (m.methodName) {
      case 'status':
        return reply(m, { ready: true, version: yt.engine.version, versionName: yt.engine.version })
      case 'updateEngine':
        yt.engine.version = yt.engine.latest
        return reply(m, { status: 'DONE', version: yt.engine.version })
      case 'search':
        return reply(m, { json: read('search.json'), client: 'default' })
      case 'playlist':
        return reply(m, { json: read('playlist.json'), client: 'default' })
      case 'info':
        if (o.streams && yt.failStreams) return reply(m, undefined, false, 'Sign in to confirm you are not a bot')
        return reply(m, { json: o.streams ? streamJson() : read('stream.json'), client: 'default' })
      case 'enqueue': {
        const t = (yt.known[o.id] = { ...o, pause: false, cancel: false })
        yt.tasks[o.id] = t
        emit('dlState', { id: o.id, state: 'queued' })
        setTimeout(() => runTask(t), 100)
        return reply(m, {})
      }
      case 'pause':
        if (yt.tasks[o.id]) yt.tasks[o.id].pause = true
        return reply(m, {})
      case 'cancel':
        if (yt.tasks[o.id]) yt.tasks[o.id].cancel = true
        return reply(m, {})
      case 'getActive':
        return reply(m, { ids: Object.keys(yt.tasks) })
      default:
        return reply(m, {})
    }
  }

  // GitHub's answer to "what is the newest yt-dlp?"
  const prevFetch = window.fetch.bind(window)
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.startsWith('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest')) {
      return Promise.resolve(new Response(JSON.stringify({ tag_name: yt.engine.latest }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    }
    return prevFetch(input, init)
  }

  return { handle, localSong }
}
