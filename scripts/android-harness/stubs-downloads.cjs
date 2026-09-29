/* global window */
// Stand-ins for OliDownload, Filesystem and Share (and a fake Internet Archive item) for the PC test window.
// A small real downloader (Node http, Range resume, pause, cancel, MD5) so the download list, the library and playback
// can be tried on the PC. The Java engine itself is tested separately (test/androidDownload.test.ts).
const fs = require('fs')
const path = require('path')
const http = require('http')
const nodeCrypto = require('crypto')
const os = require('os')

module.exports = function install({ BASE, FLAC_DIR }) {
  const FILES_ROOT = path.join(os.tmpdir(), 'oli-harness-files')
  const CACHE_ROOT = path.join(os.tmpdir(), 'oli-harness-cache')
  const dl = (window.__fakeDl = { calls: [], tasks: {}, listeners: {}, specs: {}, shares: [], fetches: [], fsCalls: [], throttleMs: 0 })

  const post = (msg) => setTimeout(() => window.androidBridge.onmessage({ data: JSON.stringify(msg) }), 0)
  const emitDl = (name, data) => {
    const id = dl.listeners[name]
    if (id) window.androidBridge.onmessage({ data: JSON.stringify({ callbackId: id, pluginId: 'OliDownload', methodName: 'addListener', success: true, save: true, data }) })
  }
  const reply = (m, data, success = true, error) => {
    const msg = { callbackId: m.callbackId, pluginId: m.pluginId, methodName: m.methodName, success, data }
    if (error) msg.error = { message: error }
    post(msg)
  }
  const uri = (p) => 'file:///' + p.replace(/\\/g, '/')

  function localUrl(u) {
    const m = /^https:\/\/archive\.org\/download\/oli-harness-item\/(.+)$/.exec(u)
    if (!m) return u
    const name = decodeURIComponent(m[1])
    return name === 'cover.jpg' ? BASE + '/harness/cover.jpg' : BASE + '/file/' + FLAC_DIR + '/' + encodeURIComponent(name)
  }

  function runDownload(spec) {
    const dest = path.join(FILES_ROOT, spec.relPath)
    const part = dest + '.part'
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const task = (dl.tasks[spec.id] = { pause: false, cancel: false })
    const offset = fs.existsSync(part) ? fs.statSync(part).size : 0
    emitDl('dlState', { id: spec.id, state: 'downloading', bytes: offset })
    const md = nodeCrypto.createHash('md5')
    if (offset > 0) md.update(fs.readFileSync(part))
    const url = new URL(localUrl(spec.url))
    const req = http.get(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: offset > 0 ? { Range: 'bytes=' + offset + '-' } : {} },
      (res) => {
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          delete dl.tasks[spec.id]
          emitDl('dlState', { id: spec.id, state: 'failed', error: 'Server answered HTTP ' + res.statusCode })
          return
        }
        const total = spec.size || offset + Number(res.headers['content-length'] || 0)
        const out = fs.createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' })
        let written = offset
        let last = 0
        res.on('data', (chunk) => {
          if (task.pause || task.cancel) {
            res.destroy()
            return
          }
          out.write(chunk)
          md.update(chunk)
          if (dl.throttleMs > 0) {
            res.pause()
            setTimeout(() => res.resume(), dl.throttleMs)
          }
          written += chunk.length
          const now = Date.now()
          if (now - last > 200) {
            last = now
            emitDl('dlProgress', { id: spec.id, bytes: written, total, speed: 5000000 })
          }
        })
        res.on('close', () => {
          out.end(() => {
            delete dl.tasks[spec.id]
            if (task.cancel) {
              try {
                fs.unlinkSync(part)
              } catch (e) {
                // none
              }
              return emitDl('dlState', { id: spec.id, state: 'canceled' })
            }
            if (task.pause) return emitDl('dlState', { id: spec.id, state: 'paused', bytes: fs.statSync(part).size })
            const digest = md.digest('hex')
            if (spec.md5 && spec.md5.toLowerCase() !== digest) {
              try {
                fs.unlinkSync(part)
              } catch (e) {
                // none
              }
              return emitDl('dlState', { id: spec.id, state: 'failed', error: 'Checksum mismatch: the file is damaged, it was deleted' })
            }
            fs.renameSync(part, dest)
            emitDl('dlState', { id: spec.id, state: 'completed', path: uri(dest), size: fs.statSync(dest).size, md5: digest, tagged: true, tagNote: '' })
          })
        })
      }
    )
    req.on('error', (e) => {
      delete dl.tasks[spec.id]
      emitDl('dlState', { id: spec.id, state: 'failed', error: 'Connection problem: ' + e.message })
    })
  }

  function handleDownload(m) {
    const o = m.options || {}
    if (m.methodName === 'addListener') {
      dl.listeners[o.eventName] = m.callbackId
      return
    }
    dl.calls.push({ name: m.methodName, arg: o })
    switch (m.methodName) {
      case 'getRoot':
        return reply(m, { root: FILES_ROOT })
      case 'enqueue':
        dl.specs[o.id] = o
        if (!dl.tasks[o.id]) {
          emitDl('dlState', { id: o.id, state: 'queued' })
          setTimeout(() => runDownload(o), 100)
        }
        return reply(m, {})
      case 'pause':
        if (dl.tasks[o.id]) dl.tasks[o.id].pause = true
        return reply(m, {})
      case 'resume':
        if (dl.specs[o.id] && !dl.tasks[o.id]) runDownload(dl.specs[o.id])
        return reply(m, {})
      case 'cancel':
        if (dl.tasks[o.id]) dl.tasks[o.id].cancel = true
        else if (o.relPath) {
          try {
            fs.unlinkSync(path.join(FILES_ROOT, o.relPath + '.part'))
          } catch (e) {
            // none
          }
        }
        return reply(m, {})
      case 'getActive':
        return reply(m, { ids: Object.keys(dl.tasks) })
      case 'writeTags':
        return reply(m, { written: true, note: '' })
      default:
        return reply(m, {})
    }
  }

  function handleFs(m) {
    const o = m.options || {}
    dl.fsCalls.push({ name: m.methodName, path: o.path, directory: o.directory })
    const root = o.directory === 'CACHE' ? CACHE_ROOT : FILES_ROOT
    const target = path.join(root, o.path || '')
    try {
      switch (m.methodName) {
        case 'readdir': {
          if (!fs.existsSync(target)) return reply(m, undefined, false, 'Directory does not exist')
          return reply(m, {
            files: fs.readdirSync(target).map((name) => {
              const st = fs.statSync(path.join(target, name))
              return { name, type: 'file', size: st.size, ctime: st.ctimeMs, mtime: st.mtimeMs, uri: uri(path.join(target, name)) }
            })
          })
        }
        case 'writeFile':
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.writeFileSync(target, Buffer.from(o.data || '', 'base64'))
          return reply(m, { uri: uri(target) })
        case 'readFile':
          return reply(m, { data: fs.readFileSync(target).toString('base64') })
        case 'deleteFile':
          fs.unlinkSync(target)
          return reply(m, {})
        case 'getUri':
          return reply(m, { uri: uri(target) })
        default:
          return reply(m, {})
      }
    } catch (e) {
      return reply(m, undefined, false, String((e && e.message) || e))
    }
  }

  function handleShare(m) {
    dl.shares.push(m.options)
    return reply(m, m.methodName === 'canShare' ? { value: true } : { activityType: 'harness' })
  }

  // The Internet Archive item used by the download test: 3 real FLAC files of A:\Flac. The rest of the network is untouched.
  let items = null
  function harnessFiles() {
    if (items) return items
    const names = fs
      .readdirSync(FLAC_DIR)
      .filter((n) => n.toLowerCase().endsWith('.flac'))
      .map((n) => ({ n, s: fs.statSync(path.join(FLAC_DIR, n)).size }))
      .filter((x) => x.s < 40e6)
      .sort((a, b) => a.s - b.s)
      .slice(0, 3)
    items = names.map((x, i) => ({
      name: x.n,
      format: 'Flac',
      size: String(x.s),
      length: '200',
      track: String(i + 1),
      title: x.n.replace(/\.flac$/i, ''),
      artist: 'Harness Artist',
      album: 'Harness Item',
      md5: nodeCrypto.createHash('md5').update(fs.readFileSync(path.join(FLAC_DIR, x.n))).digest('hex')
    }))
    return items
  }
  const realFetch = window.fetch.bind(window)
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    dl.fetches.push(url)
    if (url.startsWith('https://archive.org/metadata/oli-harness-item')) {
      const body = {
        metadata: { title: 'Harness Item', creator: 'Harness Artist', date: '2016-01-01' },
        files: [...harnessFiles(), { name: 'cover.jpg', format: 'JPEG', size: '3000' }]
      }
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    }
    return realFetch(input, init)
  }

  return { handleDownload, handleFs, handleShare }
}
