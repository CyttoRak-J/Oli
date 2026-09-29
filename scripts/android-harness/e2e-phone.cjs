// Fixes from the owner's first real-phone test (0.9.0), end to end in the PC test window: a tap plays a song, the back button
// goes back a page, the Now Playing screen fits with all its buttons, the red number on the Downloads tab, playing again after
// the player went idle (phone call), and a big YouTube queue coming back after a restart. Needs a FRESH profile
// (run-window.ps1); the run-all script starts it.
const { connect, sleep } = require('./drive.cjs')
const path = require('path')
const SHOTS = process.env.SHOTS || __dirname

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`)
}
const call = (c, channel, ...args) => c.ev(`return await window.cytto.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`)
async function until(fn, ms = 30000, step = 250) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) return v
    await sleep(step)
  }
}
const state = (c) => c.ev(`const s=__oliPlayer.getState(); return {id:s.current&&s.current.id,status:s.status,t:s.currentTime,q:s.queue.length}`)
const hash = (c) => c.ev(`return location.hash`)
const clickNav = (c, label) => c.ev(`[...document.querySelectorAll('nav a')].find((a) => a.innerText.trim().startsWith(${JSON.stringify(label)})).click(); return 1`)

;(async () => {
  const c = await connect()
  await c.ev(`window.confirm = () => true; return 1`)
  await until(() => c.ev(`return !!(window.cytto && globalThis.__oliPlayer && window.__fakeMedia && window.__fakeYt)`), 40000)
  await sleep(1500)
  await until(async () => (await call(c, 'library:scan-state'))?.phase === 'finished', 90000)
  await sleep(800)

  // 1. a tap plays the song (it used to open the song info)
  await clickNav(c, 'Songs')
  await until(() => c.ev(`return document.querySelectorAll('[data-track-id]').length > 3`), 15000)
  const ids = await c.ev(`return [...document.querySelectorAll('[data-track-id]')].slice(0,3).map((r) => r.getAttribute('data-track-id'))`)
  await c.ev(`const row = document.querySelector('[data-track-id="${ids[0]}"]'); [...row.querySelectorAll('button')].find((b) => b.className.includes('truncate')).click(); return 1`)
  const p1 = await until(async () => {
    const s = await state(c)
    return s.id === ids[0] && (s.status === 'playing' || s.status === 'loading') && s
  }, 20000)
  check('tapping the title of a song plays it', !!p1, JSON.stringify(p1))
  check('...and does not open the song info', (await hash(c)) === '#/songs', await hash(c))
  await c.ev(`document.querySelector('[data-track-id="${ids[1]}"]').dispatchEvent(new MouseEvent('click', { bubbles: true })); return 1`)
  const p2 = await until(async () => (await state(c)).id === ids[1], 10000)
  check('tapping the empty part of a row plays it too', !!p2, JSON.stringify(await state(c)))
  await c.ev(`const row = document.querySelector('[data-track-id="${ids[2]}"]'); [...row.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Toggle favorite').click(); return 1`)
  await sleep(500)
  check('tapping a button in the row (favorite) does not start the song', (await state(c)).id === ids[1])

  // 2. the back button
  await clickNav(c, 'Archive')
  await sleep(400)
  await clickNav(c, 'Downloads')
  await sleep(400)
  check('back: the first press returns to the previous page', (await c.ev(`return window.__oliBack()`)) === true && (await hash(c)) === '#/archive', await hash(c))
  await sleep(300)
  check('back: the second press returns to Songs', (await c.ev(`return window.__oliBack()`)) === true && (await hash(c)) === '#/songs', await hash(c))
  await sleep(300)
  check('back: the third press returns home', (await c.ev(`return window.__oliBack()`)) === true && ['#/', ''].includes(await hash(c)), await hash(c))
  await sleep(300)
  check('back: on the home page the app is left (sent to the background by the phone)', (await c.ev(`return window.__oliBack()`)) === false)

  // 3. Now Playing fits the screen and has all its buttons; back closes it
  await c.ev(`document.querySelector('[aria-label="Now playing"]').click(); return 1`)
  await sleep(800)
  const fit = await c.ev(`
    const w = innerWidth, h = innerHeight
    const names = ['Shuffle', 'Queue', 'History', 'Lyrics', 'Previous', 'Next', 'Seek']
    const out = {}
    for (const n of names) {
      const el = document.querySelector('[aria-label="' + n + '"]')
      const r = el && el.getBoundingClientRect()
      out[n] = r ? r.left >= 0 && r.right <= w && r.top >= 0 && r.bottom <= h : false
    }
    const rep = [...document.querySelectorAll('[aria-label^="Repeat"]')][0]
    const rr = rep && rep.getBoundingClientRect()
    out.Repeat = rr ? rr.left >= 0 && rr.right <= w && rr.bottom <= h : false
    const panel = document.querySelector('.absolute.inset-0.z-30')
    const pr = panel && panel.getBoundingClientRect()
    return { out, w, h, panelW: pr && Math.round(pr.width), panelH: pr && Math.round(pr.height) }`)
  await c.shot(path.join(SHOTS, 'shot-nowplaying.png'))
  check('Now Playing covers the page (full width)', fit.panelW >= fit.w - 2, JSON.stringify({ w: fit.w, panelW: fit.panelW, panelH: fit.panelH }))
  check('...with shuffle, repeat, queue, history, lyrics, previous, next and the seek bar all on the screen', Object.values(fit.out).every(Boolean), JSON.stringify(fit.out))
  await c.ev(`document.querySelector('[aria-label="Queue"]').click(); return 1`)
  await sleep(600)
  check('the Queue button opens the queue', /Queue/.test(await c.ev(`return document.querySelector('.absolute.inset-0.z-30').innerText`)))
  check('back closes the panel', (await c.ev(`return window.__oliBack()`)) === true && (await c.ev(`return !document.querySelector('.absolute.inset-0.z-30')`)))

  // 3b. a tab below the panel uncovers its page (the panel used to stay on top while the page changed behind it)
  for (const panel of ['nowplaying', 'queue', 'history', 'lyrics']) {
    await c.ev(`globalThis.__oliPanels.getState().open(${JSON.stringify(panel)}); return 1`)
    await sleep(300)
    await clickNav(c, 'Songs')
    await sleep(500)
    check(`with ${panel} open, the Songs tab shows the Songs page`, (await hash(c)) === '#/songs' && (await c.ev(`return !document.querySelector('.absolute.inset-0.z-30')`)), await hash(c))
    await clickNav(c, 'Settings')
    await sleep(400)
  }
  await c.ev(`globalThis.__oliPanels.getState().open('nowplaying'); return 1`)
  await sleep(300)
  await clickNav(c, 'Settings')
  await sleep(400)
  check('tapping the tab of the page you are already on closes the panel too', await c.ev(`return !document.querySelector('.absolute.inset-0.z-30')`))

  // 3c. swipe down on a panel: it slides away, back to the page underneath
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  const swipe = async (x, y0, y1, steps = 8) => {
    await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] })
    for (let i = 1; i <= steps; i++) {
      await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + ((y1 - y0) * i) / steps }] })
      await sleep(16)
    }
    await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await sleep(600)
  }
  const panelOpen = () => c.ev(`return !!document.querySelector('.absolute.inset-0.z-30')`)
  await clickNav(c, 'Songs')
  await sleep(400)
  await c.ev(`globalThis.__oliPanels.getState().open('nowplaying'); return 1`)
  await sleep(500)
  await swipe(150, 220, 460)
  check('swiping down on Now Playing closes it and shows the page underneath', !(await panelOpen()) && (await hash(c)) === '#/songs', await hash(c))
  await c.ev(`globalThis.__oliPanels.getState().open('nowplaying'); return 1`)
  await sleep(500)
  await swipe(150, 220, 270)
  check('a short pull only bounces back', (await panelOpen()) && (await c.ev(`return document.querySelector('.absolute.inset-0.z-30').style.transform`)) === '')
  const seekY = await c.ev(`const r = document.querySelector('[aria-label="Seek"]').getBoundingClientRect(); return Math.round(r.top + r.height / 2)`)
  await swipe(150, seekY, seekY + 260)
  check('a drag that starts on the seek bar does not close the panel', await panelOpen())
  await c.ev(`globalThis.__oliPanels.getState().open('queue'); return 1`)
  await sleep(500)
  await c.ev(`const el = document.querySelector('.absolute.inset-0.z-30 .overflow-y-auto'); el.scrollTop = 200; return 1`)
  await sleep(200)
  const scrolled = await c.ev(`return document.querySelector('.absolute.inset-0.z-30 .overflow-y-auto').scrollTop`)
  await swipe(150, 220, 460)
  check('a list that is scrolled down scrolls back up first instead of closing', scrolled === 0 || (await panelOpen()), `scrollTop was ${scrolled}`)
  await c.ev(`globalThis.__oliPanels.getState().close(); return 1`)
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: false })

  // 4. the red number on the Downloads tab
  await c.ev(`window.__fakeYt.throttleMs = 150; return 1`)
  const d1 = await call(c, 'video:download-song', 'BBBBBBBBBBB', 'best')
  const d2 = await call(c, 'video:download-song', 'DDDDDDDDDDD', 'best')
  const badge = await until(() => c.ev(`const b = document.querySelector('nav [aria-label$=" downloading"]'); return b ? b.innerText : ''`), 15000)
  const active = (await call(c, 'downloads:get')).filter((d) => d.state === 'queued' || d.state === 'downloading').length
  check('the Downloads tab shows how many files are downloading', badge === String(active) && active >= 1, `badge "${badge}", ${active} active`)
  await c.shot(path.join(SHOTS, 'shot-badge.png'))
  await call(c, 'downloads:cancel', d1)
  await call(c, 'downloads:cancel', d2)
  const gone = await until(() => c.ev(`return !document.querySelector('nav [aria-label$=" downloading"]')`), 10000)
  check('...and the number goes away when nothing is downloading', !!gone)

  // 5. play again after the player went idle (a phone call took the audio device)
  await c.ev(`__oliPlayer.getState().playTracks(${JSON.stringify([])}, 0, {source:'library',sourceId:null}); return 1`).catch(() => undefined)
  const songs = (await call(c, 'library:songs', {})).tracks
  await c.ev(`__oliPlayer.getState().playTracks(${JSON.stringify(songs.slice(0, 3))}, 0, {source:'library',sourceId:null}); return 1`)
  await until(async () => (await state(c)).status === 'playing' && (await state(c)).t > 2, 20000)
  await c.ev(`window.__fakeNative.sticky = true; window.__fakeNative.fail(); return 1`)
  await sleep(9000) // the player retries by itself and gives up while the call is still going
  const during = await state(c)
  await c.ev(`window.__fakeNative.sticky = false; window.__fakeNative.calls.length = 0; return 1`)
  await c.ev(`__oliPlayer.getState().play(); return 1`)
  const back = await until(async () => {
    const s = await state(c)
    return s.status === 'playing' && s
  }, 20000)
  check('after the failure the play button starts the song again', !!back, JSON.stringify({ during: during.status, after: back && back.status }))

  // 6. a big YouTube queue comes back after a restart, and only one song is resolved again
  const vids = Array.from({ length: 250 }, (_, i) => 'VID' + String(i).padStart(8, '0'))
  const tracks = vids.map((v, i) => ({ id: 'youtube:' + v, title: 'Queued song ' + i, artist: 'Someone', artistId: null, albumArtist: '', album: '', albumId: null, path: '', duration: 200, codec: null, format: null, bitDepth: null, sampleRate: null, artworkUrl: null, hasEmbeddedArtwork: false }))
  await c.ev(`__oliPlayer.getState().playTracks(${JSON.stringify(tracks)}, 5, {source:'search',sourceId:null}); return 1`)
  const yp = await until(async () => {
    const s = await state(c)
    return s.id === 'youtube:' + vids[5] && s.status === 'playing' && s.t > 2 && s
  }, 60000)
  check('a queue of 250 YouTube songs plays from song 6', !!yp, JSON.stringify(yp))
  await c.ev(`__oliPlayer.getState().seek(20); return 1`)
  await sleep(2500)
  await c.ev(`__oliPlayer.getState().pause(); return 1`)
  await sleep(4500) // pausing saves the place; the database is written to disk a moment later
  const savedQ = (await call(c, 'queue:get')).length
  await c.ev(`window.__fakeYt.calls.length = 0; return 1`).catch(() => undefined)
  await c.send('Page.reload')
  await sleep(5000)
  await until(() => c.ev(`return !!(window.cytto && globalThis.__oliPlayer && window.__fakeMedia && window.__fakeYt)`), 40000)
  const rs = await until(async () => {
    const s = await state(c)
    return s.id === 'youtube:' + vids[5] && s.status === 'playing' && s.t > 18 && s
  }, 60000)
  check('after a restart the whole queue is back (250 songs)', (await state(c)).q === 250, `saved ${savedQ}, restored ${(await state(c)).q}`)
  check('...and the song resumes at the place where it stopped', !!rs && rs.t >= 18 && rs.t < 40, JSON.stringify(rs))
  const resolved = await c.ev(`return window.__fakeYt.calls.filter((x) => x.name === 'info' && x.arg.streams).length`)
  check('...resolving only the song that plays and the next few, not the 250', resolved >= 1 && resolved <= 6, `${resolved} stream lookups`)

  const errs = c.consoleMsgs.filter((m) => /^\[(error|exception)\]/.test(m) && !/not in harness|FAKE_/.test(m))
  console.log('\nconsole errors/exceptions:', errs.length ? errs.slice(0, 8).join('\n  ') : 'none')
  const failed = results.filter((x) => !x.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  c.close()
  process.exit(failed.length ? 1 : 0)
})().catch((e) => {
  console.error('DRIVER ERROR', e)
  process.exit(2)
})
