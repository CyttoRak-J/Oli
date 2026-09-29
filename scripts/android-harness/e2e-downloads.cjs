// Phase 2 end to end in the test window: the Internet Archive download queue (start, pause, resume, cancel, restart),
// the finished files becoming songs, tag editing, and backup / export / restore. Needs a FRESH profile (run-window.ps1).
// The transfers are done by a Node stand-in for the Java plugin (see stubs-downloads.cjs).
const { connect, sleep } = require('./drive.cjs')
const path = require('path')
const fs = require('fs')
const os = require('os')
const SHOTS = process.env.SHOTS || __dirname

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`)
}
const call = (c, channel, ...args) => c.ev(`return await window.cytto.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`)
const downloads = (c) => call(c, 'downloads:get')

async function until(fn, ms = 30000, step = 250) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) return v
    await sleep(step)
  }
}

;(async () => {
  const c = await connect()
  await c.ev(`window.confirm = () => true; return 1`)
  await until(() => c.ev(`return !!(window.cytto && globalThis.__oliPlayer && window.__fakeDl)`), 30000)
  await sleep(2000)

  // ---------------------------------------------------------------- enqueue three files from the fake archive item
  const item = await call(c, 'archive:item', 'oli-harness-item')
  const names = item.files.map((f) => f.name)
  check('the archive item lists 3 FLAC files', names.length === 3 && item.files.every((f) => f.md5), names.map((n) => n.slice(0, 20)).join(' | '))
  await c.ev(`window.__fakeDl.throttleMs = 40; return 1`)
  const r = await call(c, 'archive:enqueue', 'oli-harness-item', names)
  check('all three were queued', r.found === 3 && r.enqueued === 3, JSON.stringify(r))
  const dup = await call(c, 'archive:enqueue', 'oli-harness-item', names)
  check('asking again while they run adds nothing twice', dup.enqueued === 0, JSON.stringify(dup))

  // ---------------------------------------------------------------- progress + pause / resume
  const running = await until(async () => {
    const l = await downloads(c)
    return l.find((d) => d.state === 'downloading' && d.progress > 0.02)
  })
  check('a download shows real progress (state, percentage, speed)', !!running && running.speed > 0, running && `${(running.progress * 100).toFixed(0)}%  ${running.title.slice(0, 25)}`)
  const spec = await c.ev(`return window.__fakeDl.calls.find(x=>x.name==='enqueue').arg`)
  check('the native plugin got md5, size, cover and tags for the file', spec.md5?.length === 32 && spec.size > 0 && /cover\.jpg$/.test(spec.coverUrl) && spec.tags.artist === 'Harness Artist' && spec.tags.album === 'Harness Item' && spec.tags.trackNo > 0, JSON.stringify({ md5: spec.md5?.slice(0, 6), coverUrl: spec.coverUrl?.slice(-30), tags: spec.tags }))
  await call(c, 'downloads:pause', running.id)
  const paused = await until(async () => (await downloads(c)).find((d) => d.id === running.id && d.state === 'paused'), 8000)
  check('pause stops it and keeps what was downloaded', !!paused && paused.downloadedBytes > 0, paused && `${paused.downloadedBytes} bytes kept`)
  const partFile = path.join(os.tmpdir(), 'oli-harness-files', running.destPath + '.part')
  check('...as a .part file on disk', fs.existsSync(partFile) && fs.statSync(partFile).size > 0)
  await c.shot(path.join(SHOTS, 'shot-downloads-running.png'))
  await c.ev(`location.hash='#/downloads'; return 1`)
  await sleep(1200)
  await c.shot(path.join(SHOTS, 'shot-downloads-page.png'))
  await call(c, 'downloads:resume', running.id)
  await c.ev(`window.__fakeDl.throttleMs = 0; return 1`)

  const allDone = await until(async () => {
    const l = await downloads(c)
    return l.length >= 3 && l.every((d) => d.state === 'completed') && l
  }, 60000)
  check('after resuming, all three finish', !!allDone, (await downloads(c)).map((d) => d.state).join(','))
  const sends = await c.ev(`return window.__fakeDl.calls.filter(x=>x.name==='enqueue' && x.arg.id===${JSON.stringify(running.id)}).length`)
  check('resume sent the same download to the service again (it continues from the .part file)', sends === 2, `${sends} enqueue calls for that download`)
  const md5ok = allDone && allDone.every((d) => fs.existsSync(d.destPath.replace('file:///', '')))
  check('the finished files exist in the app folder', md5ok)

  // ---------------------------------------------------------------- the songs
  const songs = (await call(c, 'library:songs', {})).tracks.filter((t) => t.album === 'Harness Item')
  check('the downloads became songs with their tags', songs.length === 3 && songs.every((s) => s.artist === 'Harness Artist' && s.trackNo > 0), songs.map((s) => `${s.trackNo}:${s.title.slice(0, 15)}`).join(' | '))
  check('their real format was read from the files (sample rate, bit depth)', songs.every((s) => s.sampleRate > 0), songs.map((s) => `${s.sampleRate}/${s.bitDepth}`).join(' '))
  check('their paths point into the app folder (file://)', songs.every((s) => s.path.startsWith('file:///')) && songs.every((s) => s.path.includes('oli-harness-files')))
  await c.ev(`__oliPlayer.getState().playTracks(${JSON.stringify(songs)}, 0, {source:'downloads',sourceId:null}); return 1`)
  const playing = await until(async () => {
    const st = await c.ev(`const s=__oliPlayer.getState(); return {status:s.status,t:s.currentTime}`)
    return st.status === 'playing' && st.t > 1
  }, 20000)
  check('a downloaded song plays', !!playing)

  // ---------------------------------------------------------------- cancel
  await c.ev(`__oliPlayer.getState().pause && 1; window.__fakeDl.throttleMs = 60; return 1`)
  await call(c, 'downloads:clear-completed')
  const r2 = await call(c, 'archive:enqueue', 'oli-harness-item', [names[0]])
  const started = await until(async () => (await downloads(c)).find((d) => d.state === 'downloading' && d.downloadedBytes > 0))
  await call(c, 'downloads:cancel', started.id)
  await sleep(1500)
  const canceled = (await downloads(c)).find((d) => d.id === started.id)
  const part2 = path.join(os.tmpdir(), 'oli-harness-files', started.destPath + '.part')
  check('cancel removes the download and its partial file', r2.enqueued === 1 && canceled.state === 'canceled' && !fs.existsSync(part2))

  // ---------------------------------------------------------------- restart in the middle of a download
  await call(c, 'downloads:clear-completed')
  await call(c, 'archive:enqueue', 'oli-harness-item', [names[1]])
  const mid = await until(async () => (await downloads(c)).find((d) => d.state === 'downloading' && d.downloadedBytes > 300000))
  const partBefore = mid && fs.statSync(path.join(os.tmpdir(), 'oli-harness-files', mid.destPath + '.part')).size
  await c.send('Page.reload')
  await sleep(6000)
  await until(() => c.ev(`return !!(window.cytto && window.__fakeDl)`), 30000)
  await c.ev(`window.confirm = () => true; window.__fakeDl.throttleMs = 0; return 1`) // a reload forgets the override
  const after = await until(async () => (await downloads(c)).find((d) => d.id === mid.id && d.state === 'completed'), 40000)
  check('after the app restarted the interrupted download carried on and finished', !!after, `had ${partBefore} bytes when the app restarted`)
  const resumeSpec = await c.ev(`return window.__fakeDl.calls.filter(x=>x.name==='enqueue').length`)
  check('...by itself (the queue re-sent it to the service)', resumeSpec >= 1)

  // ---------------------------------------------------------------- tag editing
  const first = (await call(c, 'library:songs', {})).tracks.find((t) => t.album === 'Harness Item')
  await c.ev(`window.__fakeDl.calls.length = 0; return 1`)
  const ok = await call(c, 'metadata:edit', first.id, { title: 'Edited title', artist: 'Edited artist', trackNo: 9, year: 2001 })
  const edited = await call(c, 'library:song-by-id', first.id)
  check('editing a song updates the library', ok === true && edited.title === 'Edited title' && edited.artist === 'Edited artist' && edited.trackNo === 9 && edited.year === 2001, JSON.stringify({ t: edited.title, a: edited.artist }))
  const wrote = await c.ev(`return window.__fakeDl.calls.filter(x=>x.name==='writeTags').map(x=>x.arg)`)
  check("...and asks the native side to write the file's tags (own downloads)", wrote.length === 1 && wrote[0].tags.title === 'Edited title' && wrote[0].tags.trackNo === 9, JSON.stringify(wrote[0] && wrote[0].tags))
  check('the artist moved with the edit (new artist exists)', (await call(c, 'library:artists')).some((a) => a.name === 'Edited artist'))

  // ---------------------------------------------------------------- backup / export / restore
  const before = (await call(c, 'library:songs', {})).total
  const name = await call(c, 'backup:create')
  const list = await call(c, 'backup:list')
  check('a backup can be created and listed (the automatic daily one may be there too)', typeof name === 'string' && list.some((b) => b.name === name), JSON.stringify(list.map((b) => b.name)))
  const exportOk = await call(c, 'backup:export')
  const shares = await c.ev(`return window.__fakeDl.shares`)
  check('export hands a .sqlite copy to the share sheet', exportOk === true && shares.length === 1 && /\.sqlite$/.test(shares[0].url), shares[0] && shares[0].url.slice(-40))
  await call(c, 'library:remove-folder', 'phone:mediastore') // removes the phone songs
  const less = (await call(c, 'library:songs', {})).total
  const restored = await call(c, 'backup:restore') // window.confirm -> yes -> newest automatic backup
  await sleep(1500)
  const more = (await call(c, 'library:songs', {})).total
  check('restore brings the library back exactly', restored === true && less < before && more === before, `${before} songs -> ${less} after removing -> ${more} after restore`)

  await c.ev(`location.hash='#/downloads'; return 1`)
  await sleep(1000)
  await c.shot(path.join(SHOTS, 'shot-downloads-done.png'))
  const errs = c.consoleMsgs.filter((m) => /^\[(error|exception)\]/.test(m) && !/not in harness/.test(m))
  console.log('\nconsole errors/exceptions:', errs.length ? errs.slice(0, 8).join('\n  ') : 'none')
  const failed = results.filter((x) => !x.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  c.close()
  process.exit(failed.length ? 1 : 0)
})().catch((e) => {
  console.error('DRIVER ERROR', e)
  process.exit(2)
})
