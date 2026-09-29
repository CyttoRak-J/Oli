// Speed test of the phone build with a big made-up library (run the window with OLI_HARNESS_SONGS=N on a FRESH profile).
// The PC is much faster than a phone: CPU=4 (default) slows the page down 4x, which is roughly a mid-range phone. These are
// estimates for the "native rewrite" triggers in ANDROID_PLAN.md, not phone measurements.
const { connect, sleep } = require('./drive.cjs')

const CPU = Number(process.env.CPU || 4)
const call = (c, channel, ...args) => c.ev(`return await window.cytto.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`)

;(async () => {
  const c = await connect()
  await c.send('Emulation.setCPUThrottlingRate', { rate: CPU })
  const t0 = Date.now()
  for (let i = 0; i < 400; i++) {
    if (await c.ev(`return !!(window.cytto && window.__fakeMedia)`)) break
    await sleep(100)
  }
  const bootMs = Date.now() - t0

  console.error('stage: boot', Date.now() - t0)
  // ------------------------------------------------------------ a full scan from nothing (under the slowdown)
  await call(c, 'library:remove-folder', 'phone:mediastore')
  await sleep(500)
  const marks = {}
  const scanStart = Date.now()
  await call(c, 'library:add-folder')
  let found = 0
  for (;;) {
    const st = await call(c, 'library:scan-state')
    if (st) {
      found = st.filesFound || found
      if (!marks[st.phase]) marks[st.phase] = Date.now() - scanStart
      if (st.phase === 'finished' || st.phase === 'error') break
    }
    if (Date.now() - scanStart > 20 * 60 * 1000) break
    await sleep(150)
  }
  const stats = await call(c, 'library:stats')
  const dbBytes = await c.ev(`
    const db = await new Promise((res, rej) => { const r = indexedDB.open('oli', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const v = await new Promise((res) => { const r = db.transaction('files').objectStore('files').get('library.sqlite'); r.onsuccess = () => res(r.result) })
    return v ? v.byteLength : 0`)

  console.error('stage: scan done', Date.now() - t0)
  // ------------------------------------------------------------ opening the list
  const openMs = await c.ev(`
    location.hash = '#/'
    await new Promise((r) => setTimeout(r, 500))
    const t = performance.now()
    location.hash = '#/songs'
    for (let i = 0; i < 3000; i++) {
      if (document.querySelectorAll('[data-track-id]').length >= 10) return Math.round(performance.now() - t)
      await new Promise((r) => setTimeout(r, 20))
    }
    return -1`)

  console.error('stage: list opened', Date.now() - t0)
  // ------------------------------------------------------------ scrolling through the whole list
  const total = (await call(c, 'library:songs', {})).total
  const scroll = await c.ev(`
    const TOTAL = ${total}
    const el = [...document.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 200 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)).sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
    if (!el) return { error: 'no scroll container' }
    const frames = []
    let last = performance.now()
    let running = true
    const tick = (now) => { frames.push(now - last); last = now; if (running) requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    const start = performance.now()
    let steps = 0
    // scroll roughly one screen every 100 ms, like a fast flick, until every row was shown (or 60 s)
    while (performance.now() - start < 60000) {
      el.scrollTop += el.clientHeight * 0.8
      steps++
      await new Promise((r) => setTimeout(r, 100))
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 5) break
    }
    running = false
    await new Promise((r) => setTimeout(r, 100))
    frames.sort((a, b) => a - b)
    const pct = (p) => Math.round(frames[Math.min(frames.length - 1, Math.floor(frames.length * p))])
    return { frames: frames.length, median: pct(0.5), p95: pct(0.95), worst: Math.round(frames[frames.length - 1]), over50: frames.filter((f) => f > 50).length, secondsToBottom: Math.round((performance.now() - start) / 100) / 10, rowsMountedAtEnd: document.querySelectorAll('[data-track-id]').length, totalRows: TOTAL, scrolledPx: el.scrollTop, listHeight: el.scrollHeight }`)

  console.error('stage: scrolled', Date.now() - t0)
  // ------------------------------------------------------------ local search
  const searchMs = await c.ev(`
    const t = performance.now()
    await window.cytto.invoke('search:run', 'song number 77', {}, false)
    return Math.round(performance.now() - t)`)
  const heap = await c.ev(`return performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1`)

  console.error('stage: searched', Date.now() - t0)
  // ------------------------------------------------------------ restart with the library already stored
  await c.send('Page.reload')
  const r0 = Date.now()
  await sleep(300)
  for (let i = 0; i < 1200; i++) {
    try {
      if (await c.ev(`return !!(window.cytto && window.__fakeMedia)`)) break
    } catch {
      // page still loading
    }
    await sleep(100)
  }
  const ready = Date.now() - r0
  await c.ev(`location.hash = '#/songs'; return 1`)
  const firstRows = await c.ev(`
    const t = performance.now()
    for (let i = 0; i < 1000; i++) {
      if (document.querySelectorAll('[data-track-id]').length >= 10) return Math.round(performance.now() - t)
      await new Promise((r) => setTimeout(r, 20))
    }
    return -1`)

  console.log(
    JSON.stringify(
      {
        songs: found,
        cpuSlowdown: CPU,
        firstOpenBootMs: bootMs,
        scanMs: marks,
        libraryStats: stats && { songs: stats.songs ?? stats.totalSongs, albums: stats.albums, artists: stats.artists },
        databaseMB: Number((dbBytes / 1048576).toFixed(2)),
        songsPageFirstRowsMs: openMs,
        scroll,
        localSearchMs: searchMs,
        jsHeapMBAfterScroll: heap,
        restart: { appReadyMs: ready, songsPageFirstRowsMs: firstRows }
      },
      null,
      1
    )
  )
  c.close()
})().catch((e) => {
  console.error('DRIVER ERROR', e)
  process.exit(2)
})
