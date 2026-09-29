const { connect, sleep } = require('./drive.cjs')
const path = require('path')
const SHOTS = process.env.SHOTS || path.join(__dirname)

const HI = 'A:/Flac/All Harris Jayaraj Songs ( Tamil)/Harris Jayaraj, Vijay Prakash/Irandaam Ulagam (Original Motion Picture Soundtrack)/Vinnaithaandi - Harris Jayaraj, Vijay Prakash.flac'
const CD1 = 'A:/Flac/A Love Blossoms - G. V. Prakash, Flute Navin.flac'
const CD2 = 'A:/Flac/A Love for Life - G. V. Prakash, Flute Navin, Chennai Symphony.flac'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`)
}

;(async () => {
  const c = await connect()
  // wait for app + test hook
  for (let i = 0; i < 40; i++) {
    const ready = await c.ev(`return !!(globalThis.__oliPlayer && window.cytto && window.__fakeNative)`)
    if (ready) break
    await sleep(500)
  }
  const info = await c.ev(`return { platform: window.cytto.platform, cap: window.Capacitor.getPlatform(), hooks: typeof window.__oliPlayer }`)
  check('app booted as android platform with test hooks', info.platform === 'android' && info.cap === 'android', JSON.stringify(info))
  await sleep(1500)
  const initCalls = await c.ev(`return window.__fakeNative.calls.map(c=>c.name)`)
  check('player attached to the native plugin (volume sent at start)', initCalls.includes('setVolume'), initCalls.join(','))

  const mk = (id, file, extra = {}) =>
    `{id:'${id}',title:'Song ${id}',artist:'Artist',album:'Album',path:'file:///${file}',duration:200,codec:'flac',format:'FLAC',bitDepth:${extra.bitDepth ?? 16},sampleRate:${extra.sampleRate ?? 44100},artworkUrl:null,hasEmbeddedArtwork:false}`
  const tracksExpr = `[${mk('hi', HI, { bitDepth: 24, sampleRate: 96000 })}, ${mk('cd1', CD1)}, ${mk('cd2', CD2)}]`

  // 1. play the hi-res file
  await c.ev(`window.__fakeNative.calls.length = 0; window.__fakeNative.events.length = 0; __oliPlayer.getState().playTracks(${tracksExpr}, 0, {source:'library',sourceId:null}); return 1`)
  let st
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    st = await c.ev(`const s=__oliPlayer.getState(); return {status:s.status,dur:s.duration,t:s.currentTime,id:s.current&&s.current.id}`)
    if (st.status === 'playing' && st.t > 1) break
  }
  check('hi-res FLAC starts playing through the native plugin', st.status === 'playing' && st.dur > 60, JSON.stringify(st))
  const load1 = await c.ev(`return window.__fakeNative.calls.filter(c=>c.name==='loadSource')[0]`)
  check('native load got the file URI, bit depth 24 hint, autoplay false', load1 && load1.arg.url.startsWith('file:///A:/Flac/') && load1.arg.bitDepth === 24 && load1.arg.autoplay === false, JSON.stringify(load1 && { url: load1.arg.url.slice(0, 30), bitDepth: load1.arg.bitDepth }))
  const meta = await c.ev(`return window.__fakeNative.meta`)
  check('notification labels sent (title/artist/album)', meta && meta.title === 'Song hi' && meta.artist === 'Artist' && meta.album === 'Album', JSON.stringify(meta))
  const advance = await c.ev(`const a=__oliPlayer.getState().currentTime; await new Promise(r=>setTimeout(r,1500)); return __oliPlayer.getState().currentTime-a`)
  check('progress advances while playing (timeupdate from native events)', advance > 1, `+${advance.toFixed(2)}s in 1.5s`)

  // screenshot with the player bar
  await c.ev(`location.hash='#/'; return 1`)
  await sleep(800)
  await c.shot(path.join(SHOTS, 'shot-player.png'))

  // 2. seek
  await c.ev(`__oliPlayer.getState().seek(120); return 1`)
  await sleep(1500)
  const seekCall = await c.ev(`return window.__fakeNative.calls.filter(c=>c.name==='seekTo').pop()`)
  const afterSeek = await c.ev(`return {t: __oliPlayer.getState().currentTime, st: __oliPlayer.getState().status}`)
  check('seek bar drag -> native seekTo 120000 ms', seekCall && seekCall.arg.positionMs === 120000, JSON.stringify(seekCall && seekCall.arg))
  check('after the seek the position is ~120 s and still playing', Math.abs(afterSeek.t - 121) < 3 && afterSeek.st === 'playing', JSON.stringify(afterSeek))

  // 3. pause / resume through the UI store
  await c.ev(`__oliPlayer.getState().toggle(); return 1`)
  await sleep(800)
  let s2 = await c.ev(`return {status:__oliPlayer.getState().status, paused: window.__fakeNative.audio.paused}`)
  check('pause button pauses the native player', s2.status === 'paused' && s2.paused === true, JSON.stringify(s2))
  const tPaused = await c.ev(`return __oliPlayer.getState().currentTime`)
  await c.ev(`__oliPlayer.getState().toggle(); return 1`)
  await sleep(1500)
  s2 = await c.ev(`return {status:__oliPlayer.getState().status, t:__oliPlayer.getState().currentTime, id:__oliPlayer.getState().current.id}`)
  check('resume continues the same song from the same place', s2.status === 'playing' && s2.id === 'hi' && s2.t >= tPaused - 0.5, `paused at ${tPaused.toFixed(1)} -> ${s2.t.toFixed(1)}`)

  // 4. outside pause (headphones unplugged) and resume (notification Play)
  await c.ev(`window.__fakeNative.outsidePause('audioBecomingNoisy'); return 1`)
  await sleep(600)
  s2 = await c.ev(`return __oliPlayer.getState().status`)
  check('headphones unplugged -> the app shows paused', s2 === 'paused', s2)
  await c.ev(`window.__fakeNative.outsideResume(); return 1`)
  await sleep(1200)
  s2 = await c.ev(`return __oliPlayer.getState().status`)
  check('notification Play button -> the app shows playing', s2 === 'playing', s2)

  // 5. lock-screen next / previous
  await c.ev(`window.__fakeNative.command('next'); return 1`)
  await sleep(2500)
  s2 = await c.ev(`return {id:__oliPlayer.getState().current.id, status:__oliPlayer.getState().status}`)
  check('lock-screen Next -> song 2 plays', s2.id === 'cd1' && s2.status === 'playing', JSON.stringify(s2))

  // 6. end of song -> next song by itself
  const dur = await c.ev(`return __oliPlayer.getState().duration`)
  await c.ev(`__oliPlayer.getState().seek(${Math.floor(dur) - 3}); return 1`)
  let ended = false
  for (let i = 0; i < 30; i++) {
    await sleep(500)
    const id = await c.ev(`return __oliPlayer.getState().current.id`)
    if (id === 'cd2') { ended = true; break }
  }
  check('song ends -> the next song starts by itself', ended)
  await sleep(1500)
  s2 = await c.ev(`return __oliPlayer.getState().status`)
  check('...and is playing', s2 === 'playing', s2)

  // 7. broken file gets skipped (cd2 is last; put a broken one before a good one)
  await c.ev(`__oliPlayer.getState().playTracks([{id:'bad',title:'Missing',artist:'A',album:'B',path:'file:///A:/Flac/does-not-exist.flac',duration:100,codec:'flac'}, ${mk('good', CD1)}], 0, {source:'library',sourceId:null}); return 1`)
  let skipped = false
  for (let i = 0; i < 30; i++) {
    await sleep(500)
    const id = await c.ev(`return __oliPlayer.getState().current.id`)
    if (id === 'good') { skipped = true; break }
  }
  check('a missing file is skipped and the next one plays', skipped)
  await sleep(1500)
  s2 = await c.ev(`return __oliPlayer.getState().status`)
  check('...and is playing', s2 === 'playing', s2)

  // 8. speed / volume reach the native side
  await c.ev(`__oliPlayer.getState().setVolume(0.35); return 1`)
  await sleep(300)
  const vol = await c.ev(`return window.__fakeNative.calls.filter(c=>c.name==='setVolume').pop().arg.volume`)
  check('volume slider -> native setVolume', Math.abs(vol - 0.35) < 0.01, String(vol))

  // 9. settings page: Audio output section with the diagnostics + bit-perfect toggle
  await c.ev(`location.hash='#/settings'; return 1`)
  await sleep(1500)
  const txt = await c.ev(`return document.body.innerText`)
  check('Settings shows the "Audio output" section', /audio output/i.test(txt) && /Bit-perfect/i.test(txt))
  check('Settings shows the honest lines (decoder, mixer rate, what happens)', /decoder/i.test(txt) && /android mixer rate/i.test(txt) && /what happens/i.test(txt))
  await c.shot(path.join(SHOTS, 'shot-settings.png'))
  const errs = c.consoleMsgs.filter((m) => /^\[(error|exception)\]/.test(m) && !/not in harness/.test(m))
  console.log('\nconsole errors/exceptions:', errs.length ? errs.slice(0, 8).join('\n  ') : 'none')
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  c.close()
  process.exit(failed.length ? 1 : 0)
})().catch((e) => { console.error('DRIVER ERROR', e); process.exit(2) })
