// The song list with a big library (window started with OLI_HARNESS_SONGS=3000 on a FRESH profile): only the rows on screen
// exist, every row can be reached, and "go to the playing song" works for a row that is not in the page.
const { connect, sleep } = require('./drive.cjs')
const path = require('path')
const SHOTS = process.env.SHOTS || __dirname

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`)
}
const call = (c, channel, ...args) => c.ev(`return await window.cytto.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`)
async function until(fn, ms = 60000, step = 200) {
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
  await until(() => c.ev(`return !!(window.cytto && globalThis.__oliPlayer && window.__fakeMedia)`), 40000)
  const done = await until(async () => {
    const st = await call(c, 'library:scan-state')
    return st && st.phase === 'finished' && st
  }, 120000)
  check('the big library is scanned', !!done && done.filesFound === 3000, done && `${done.filesFound} songs`)

  await c.ev(`location.hash='#/songs'; return 1`)
  await until(() => c.ev(`return document.querySelectorAll('[data-track-id]').length >= 10`), 20000)
  const info = await c.ev(`
    const el = [...document.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 200 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)).sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
    return { rows: document.querySelectorAll('[data-track-id]').length, height: el.scrollHeight, count: (document.body.innerText.match(/(\\d+) tracks/) || [])[1] }`)
  check('3,000 songs, but only the ones on screen are in the page', info.rows > 10 && info.rows < 60 && info.count === '3000', JSON.stringify(info))
  check('the list still has its full height (so the scroll bar is right)', info.height > 3000 * 44 && info.height < 3000 * 48 + 600, `${info.height}px`)
  await c.shot(path.join(SHOTS, 'shot-list-top.png'))

  // jump to the middle and to the end
  const mid = await c.ev(`
    const el = [...document.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 200 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)).sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
    el.scrollTop = 46 * 1500
    await new Promise((r) => setTimeout(r, 600))
    const top = el.getBoundingClientRect().top
    const seen = [...document.querySelectorAll('[data-track-id]')].filter((r) => { const b = r.getBoundingClientRect(); return b.bottom > top + 60 && b.top < top + el.clientHeight })
    return { first: seen[0].innerText.split('\\n')[0], last: seen[seen.length - 1].innerText.split('\\n')[0], n: seen.length }`)
  check('scrolling to the middle shows the songs there (rows near 1,500)', Number(mid.first) > 1480 && Number(mid.first) < 1520, JSON.stringify(mid))
  const end = await c.ev(`
    const el = [...document.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 200 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)).sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
    el.scrollTop = el.scrollHeight
    await new Promise((r) => setTimeout(r, 600))
    const ids = [...document.querySelectorAll('[data-track-id]')]
    return { last: ids[ids.length - 1].innerText.split('\\n').slice(0, 3).join(' | '), n: ids.length }`)
  check('the very last song can be reached', /3000\b/.test(end.last), end.last)

  // play a song from deep in the list, scroll away, use "go to playing track"
  const songs = (await call(c, 'library:songs', {})).tracks
  const deep = songs[2200]
  // the made-up songs have no audio: show one as the current (paused) song instead of playing it
  await c.ev(`__oliPlayer.setState({ queue: ${JSON.stringify(songs.slice(2200, 2210))}, index: 0, current: ${JSON.stringify(deep)}, status: 'paused' }); return 1`)
  await sleep(800)
  await c.ev(`
    const el = [...document.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 200 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)).sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
    el.scrollTop = 0
    return 1`)
  await sleep(600)
  const before = await c.ev(`return document.querySelectorAll('[data-track-id="${deep.id}"]').length`)
  check('the playing song (row 2,200) is not in the page while we look at the top', before === 0)
  await c.ev(`document.querySelector('[aria-label="Go to playing track"]').click(); return 1`)
  const arrived = await until(() => c.ev(`const r = document.querySelector('[data-track-id="${deep.id}"]'); if (!r) return false; const b = r.getBoundingClientRect(); return b.top > 0 && b.top < window.innerHeight`), 8000, 250)
  check('"Go to playing track" scrolls the list to it', !!arrived)
  await sleep(600)
  await c.shot(path.join(SHOTS, 'shot-list-playing.png'))
  const centered = await c.ev(`
    const r = document.querySelector('[data-track-id="${deep.id}"]').getBoundingClientRect()
    return { top: Math.round(r.top), viewH: window.innerHeight }`)
  check('...and the song is on screen', centered.top > 0 && centered.top < centered.viewH, JSON.stringify(centered))

  const errs = c.consoleMsgs.filter((m) => /^\[(error|exception)\]/.test(m) && !/not in harness/.test(m))
  console.log('\nconsole errors/exceptions:', errs.length ? errs.slice(0, 8).join('\n  ') : 'none')
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  c.close()
  process.exit(failed.length ? 1 : 0)
})().catch((e) => {
  console.error('DRIVER ERROR', e)
  process.exit(2)
})
