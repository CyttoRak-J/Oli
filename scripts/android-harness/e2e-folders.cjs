// Choosing music folders, end to end in the test window: the real Settings screen, the real scanner/database code, the
// folder picker and the folder-filtered music list stood in by preload.cjs.
// usage: window started with OLI_HARNESS_SUBDIRS=1 on a FRESH profile (run-all.ps1 does this), then: node e2e-folders.cjs
//   A:\Flac songs 1-30 are in "Music/Rock", 31-60 in "Music/Jazz".
const { connect, sleep } = require('./drive.cjs')
const path = require('path')
const SHOTS = process.env.SHOTS || __dirname

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`)
}
const call = (c, channel, ...args) => c.ev(`return await window.cytto.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`)

async function waitScan(c, ms = 60000) {
  await sleep(600)
  const t0 = Date.now()
  for (;;) {
    const st = await call(c, 'library:scan-state')
    if (st && (st.phase === 'finished' || st.phase === 'error')) return st
    if (Date.now() - t0 > ms) return st
    await sleep(400)
  }
}
const pick = (c, path_, label) => c.ev(`window.__fakeMedia.pick = ${JSON.stringify({ volume: 'primary', path: path_, label: label || path_ })}; return 1`)
const folders = async (c) => (await call(c, 'library:get')).map((f) => `${f.id.replace('phone:dir:primary|', '')}=${f.trackCount}`).join(', ')
const total = async (c) => ((await call(c, 'library:stats')).trackCount)

;(async () => {
  const c = await connect()
  for (let i = 0; i < 60; i++) {
    if (await c.ev(`return !!(window.cytto && globalThis.__oliPlayer && window.__fakeMedia)`)) break
    await sleep(500)
  }
  await sleep(1500)
  await waitScan(c, 90000)

  // 1. first start scanned everything (the default); choosing a folder replaces that, after the owner says yes
  check('start: all phone music, 60 songs', (await folders(c)) === 'phone:mediastore=60', await folders(c))
  await pick(c, 'Music/Rock')
  const ask = await call(c, 'library:add-folder', 'folder')
  check('a folder while "all music" is scanned asks first (nothing changed)', ask === 'needs-replace' && (await total(c)) === 60, JSON.stringify(ask))
  const added = await call(c, 'library:add-folder', 'replace')
  await waitScan(c)
  check('after yes, only the chosen folder is scanned', Array.isArray(added) && (await folders(c)) === 'Music/Rock=30', await folders(c))
  check('the songs outside it left the library', (await total(c)) === 30, String(await total(c)))
  const list = await call(c, 'library:songs', {})
  check('every listed song is from that folder', (list.tracks || []).length === 30)

  // 2. a second folder
  await pick(c, 'Music/Jazz')
  await call(c, 'library:add-folder', 'folder')
  await waitScan(c)
  check('a second folder adds its songs', (await total(c)) === 60 && (await folders(c)) === 'Music/Rock=30, Music/Jazz=30', await folders(c))
  const st = await call(c, 'library:scan-state')
  check('the scan says what it holds', /60 songs in 2 folders/.test(st.message || ''), st.message)

  // 3. the folder picker was asked, and the list was asked for one folder at a time
  const asked = await c.ev(`return window.__fakeMedia.calls.filter(x=>x.name==='queryAudio' && x.arg.path).map(x=>x.arg.path)`)
  check('the music list was asked for each chosen folder only', asked.includes('Music/Rock') && asked.includes('Music/Jazz'), [...new Set(asked)].join(', '))

  // 4. a folder inside a chosen one is not added twice
  await pick(c, 'Music/Rock/Live')
  const dup = await call(c, 'library:add-folder', 'folder')
  await sleep(500)
  check('a folder inside a scanned one is not added', dup === null && (await folders(c)) === 'Music/Rock=30, Music/Jazz=30', await folders(c))
  const st2 = await call(c, 'library:scan-state')
  check('...and the owner is told', /Already included in "Music\/Rock"/.test(st2.message || ''), st2.message)

  // 5. the Settings screen
  await c.ev(`location.hash='#/settings'; return 1`)
  await sleep(1500)
  const txt = await c.ev(`return document.body.innerText`)
  check('Settings lists both folders with their song counts', /Music\/Rock/.test(txt) && /Music\/Jazz/.test(txt) && /30 songs/.test(txt))
  check('Settings has "Choose folder" and "All phone music"', /Choose folder/.test(txt) && /All phone music/.test(txt))
  await c.shot(path.join(SHOTS, 'shot-folders-settings.png'))

  // 6. a folder that contains both takes them over
  await pick(c, 'Music')
  await call(c, 'library:add-folder', 'folder')
  await waitScan(c)
  check('a parent folder takes over the folders inside it', (await folders(c)) === 'Music=60' && (await total(c)) === 60, await folders(c))

  // 7. remove one folder, then go back to all phone music from the Settings button
  await call(c, 'library:remove-folder', 'phone:dir:primary|Music')
  await sleep(600)
  check('removing the folder removes its songs', (await total(c)) === 0 && (await call(c, 'library:get')).length === 0)
  await c.ev(`location.hash='#/settings'; return 1`)
  await sleep(800)
  await c.ev(`[...document.querySelectorAll('button')].find((b) => /All phone music/.test(b.innerText)).click(); return 1`)
  await waitScan(c)
  check('"All phone music" scans everything again', (await folders(c)) === 'phone:mediastore=60', await folders(c))

  // 8. choosing a folder from the Settings button (the yes-question is a browser confirm: accept it)
  await c.ev(`window.confirm = () => true; return 1`)
  await pick(c, 'Music/Jazz')
  await c.ev(`[...document.querySelectorAll('button')].find((b) => /Choose folder/.test(b.innerText)).click(); return 1`)
  await waitScan(c)
  check('"Choose folder" in Settings switches to that folder', (await folders(c)) === 'Music/Jazz=30' && (await total(c)) === 30, await folders(c))

  // 9. after a restart the folder is still the only thing scanned
  await c.ev(`window.__fakeMedia.calls.length=0; return 1`)
  await c.send('Page.reload')
  await sleep(5000)
  for (let i = 0; i < 40; i++) {
    if (await c.ev(`return !!(window.cytto && globalThis.__oliPlayer && window.__fakeMedia)`)) break
    await sleep(500)
  }
  await sleep(2500)
  await waitScan(c, 30000)
  const asked2 = await c.ev(`return window.__fakeMedia.calls.filter(x=>x.name==='queryAudio').map(x=>x.arg.path || 'ALL')`)
  check('after a restart only that folder is scanned (no full-phone scan)', (await folders(c)) === 'Music/Jazz=30' && asked2.length > 0 && asked2.every((p) => p === 'Music/Jazz'), asked2.join(','))

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
