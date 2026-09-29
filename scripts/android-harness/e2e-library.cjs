// Phone music scan, end to end in the test window: the real phone build + the real scanner/database code, with the
// OliMedia plugin stood in by preload.cjs (lists the first 60 songs of A:\Flac and reads their real FLAC headers).
// usage: node e2e-library.cjs            (window started as described in README.md, on a fresh user-data folder)
//        OLI_HARNESS_DENY=1 was set when the window started -> run with DENY=1 to check the "permission refused" path
const { connect, sleep } = require('./drive.cjs')
const path = require('path')
const SHOTS = process.env.SHOTS || __dirname
const DENY = process.env.DENY === '1'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`)
}

const call = (c, channel, ...args) =>
  c.ev(`return await window.cytto.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`)

async function waitScan(c, ms = 90000) {
  const t0 = Date.now()
  for (;;) {
    const st = await call(c, 'library:scan-state')
    if (st && (st.phase === 'finished' || st.phase === 'error')) return st
    if (Date.now() - t0 > ms) return st
    await sleep(400)
  }
}

;(async () => {
  const c = await connect()
  for (let i = 0; i < 60; i++) {
    if (await c.ev(`return !!(window.cytto && globalThis.__oliPlayer && window.__fakeMedia)`)) break
    await sleep(500)
  }
  await sleep(1500)

  if (DENY) {
    const st = await waitScan(c, 15000)
    check('permission refused: the scan reports it plainly', st && st.phase === 'error' && /permission/i.test(st.message || ''), JSON.stringify(st && { phase: st.phase, message: st.message }))
    const n = await call(c, 'library:get')
    check('...and no library location or songs were added', Array.isArray(n) && n.length === 0, JSON.stringify(n))
    await c.ev(`location.hash='#/settings'; return 1`)
    await sleep(1200)
    await c.shot(path.join(SHOTS, 'shot-library-denied.png'))
    const txt = await c.ev(`return document.body.innerText`)
    check('Settings tells the owner what to do', /Scan phone music/i.test(txt))
    finish(c)
    return
  }

  // 1. first start: asked once, scanned by itself
  const st = await waitScan(c)
  check('first start scans the phone music by itself', st && st.phase === 'finished', JSON.stringify(st && { phase: st.phase, found: st.filesFound, added: st.filesAdded }))
  const folders = await call(c, 'library:get')
  const phone = folders.find((f) => f.id === 'phone:mediastore')
  check('"Phone music" is a library location with 60 songs', phone && phone.trackCount === 60, JSON.stringify(phone && { count: phone.trackCount, path: phone.path }))
  const perm = await c.ev(`return window.__fakeMedia.calls.map(x=>x.name)`)
  check('plugin was asked in pages, then to read details', perm.includes('queryAudio') && perm.includes('probeFiles'), [...new Set(perm)].join(','))

  // 2. what got stored
  const page = await call(c, 'library:songs', {})
  const songs = page.tracks || []
  check('songs are in the library with tags from the file name', songs.length === 60 && songs.every((s) => s.title && s.artist), `${songs.length} songs, e.g. "${songs[0] && songs[0].title}" by ${songs[0] && songs[0].artist}`)
  const withRate = songs.filter((s) => s.sampleRate > 0)
  const hires = songs.filter((s) => s.sampleRate > 44100 || s.bitDepth > 16)
  check('real sample rate and bit depth were read from the files', withRate.length === 60, `${withRate.length}/60 have a rate; ${hires.length} hi-res; rates: ${[...new Set(songs.map((s) => s.sampleRate + '/' + s.bitDepth))].join(' ')}`)
  const albums = await call(c, 'library:albums')
  check('songs are grouped into 3 albums', albums.length === 3, albums.map((a) => a.title || a.name).join(' | '))
  check('every song path is a playable URI', songs.every((s) => /^(file|content):\/\//.test(s.path)))
  check('song ids follow the desktop scheme (song:<16 hex>)', songs.every((s) => /^song:[0-9a-f]{16}$/.test(s.id)))

  // 3. screens
  await c.ev(`location.hash='#/songs'; return 1`)
  await sleep(1500)
  const txt = await c.ev(`return document.body.innerText`)
  check('Songs page lists them', txt.includes(songs[0].title), '')
  await c.shot(path.join(SHOTS, 'shot-library-songs.png'))
  await c.ev(`location.hash='#/albums'; return 1`)
  await sleep(2500)
  await c.shot(path.join(SHOTS, 'shot-library-albums.png'))
  const imgs = await c.ev(`return [...document.querySelectorAll('img')].map(i=>({src:i.src.slice(0,90), ok:i.complete && i.naturalWidth>0}))`)
  check('album covers load through the /_capacitor_file_ URL', imgs.some((i) => i.src.includes('_capacitor_file_') && i.ok), JSON.stringify(imgs.slice(0, 3)))
  const artCalls = await c.ev(`return window.__fakeMedia.calls.filter(x=>x.name==='getArtwork').length`)
  check('cover lookups are shared per album (not one per song)', artCalls > 0 && artCalls <= 6, `${artCalls} lookups`)

  // 4. play a library song
  const pick = hires[0] || songs[0]
  await c.ev(`window.__fakeNative.calls.length=0; __oliPlayer.getState().playTracks(${JSON.stringify([pick, songs[1]])}, 0, {source:'library',sourceId:null}); return 1`)
  let s2
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    s2 = await c.ev(`const s=__oliPlayer.getState(); return {status:s.status, t:s.currentTime, id:s.current&&s.current.id}`)
    if (s2.status === 'playing' && s2.t > 1) break
  }
  check('a scanned song plays through the native player', s2.status === 'playing' && s2.id === pick.id, JSON.stringify(s2))
  const bar = await c.ev(`return document.querySelector('[aria-label="Now playing"]')?.innerText || ''`)
  check('player bar shows its real format', pick.bitDepth ? bar.toUpperCase().includes(String(pick.bitDepth) + '-BIT') || bar.includes('FLAC') : bar.includes('FLAC'), bar.replace(/\n/g, ' | '))
  await c.shot(path.join(SHOTS, 'shot-library-playing.png'))

  // 5. the phone changes: two songs deleted -> marked missing; back again -> return
  await c.ev(`window.__fakeMedia.calls.length=0; window.__fakeMedia.files = window.__fakeMedia.files.slice(0,58); window.__fakeMedia.changed(); return 1`)
  await sleep(1500)
  let st2 = await waitScan(c, 20000)
  await sleep(500)
  const after = await call(c, 'library:get')
  check('songs deleted on the phone disappear (marked missing)', after.find((f) => f.id === 'phone:mediastore').trackCount === 58, `count ${after[0].trackCount}, removed ${st2 && st2.filesRemoved}`)
  const probes = await c.ev(`return window.__fakeMedia.calls.filter(x=>x.name==='probeFiles').length`)
  check('an unchanged rescan does not read the files again', probes === 0, `${probes} probe calls`)
  await c.ev(`window.__fakeMedia.files = null; return 1`)
  await call(c, 'library:rescan', false)
  await sleep(1000)
  await waitScan(c, 20000)
  await sleep(500)
  const back = await call(c, 'library:get')
  check('songs that return on the phone come back', back.find((f) => f.id === 'phone:mediastore').trackCount === 60)

  // 6. restart: data stays, no second permission question
  await c.ev(`window.__fakeMedia.calls.length=0; return 1`)
  await c.send('Page.reload')
  await sleep(5000)
  for (let i = 0; i < 40; i++) {
    if (await c.ev(`return !!(window.cytto && globalThis.__oliPlayer && window.__fakeMedia)`)) break
    await sleep(500)
  }
  await sleep(2500)
  const st3 = await waitScan(c, 30000)
  const again = await call(c, 'library:get')
  check('after a restart the songs are still there and a launch scan ran', again[0].trackCount === 60 && st3 && st3.phase === 'finished')
  const reqs = await c.ev(`return window.__fakeMedia.calls.filter(x=>x.name==='requestPermission').length`)
  const probes2 = await c.ev(`return window.__fakeMedia.calls.filter(x=>x.name==='probeFiles').length`)
  check('...without asking for permission or re-reading the files', reqs === 0 && probes2 === 0, `${reqs} requests, ${probes2} probes`)

  // 7. remove the location
  await call(c, 'library:remove-folder', 'phone:mediastore')
  await sleep(800)
  const gone = await call(c, 'library:get')
  const left = await call(c, 'library:songs', {})
  const leftN = (left.tracks || []).length
  check('removing "Phone music" removes its songs', gone.length === 0 && leftN === 0, `${gone.length} locations, ${leftN} songs`)
  finish(c)
})().catch((e) => {
  console.error('DRIVER ERROR', e)
  process.exit(2)
})

function finish(c) {
  const errs = c.consoleMsgs.filter((m) => /^\[(error|exception)\]/.test(m) && !/not in harness/.test(m))
  console.log('\nconsole errors/exceptions:', errs.length ? errs.slice(0, 8).join('\n  ') : 'none')
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  c.close()
  process.exit(failed.length ? 1 : 0)
}
