// Phase 3 end to end in the PC test window: YouTube search, pasted links, playlists, playing a video's audio, the engine
// status and update, and YouTube song / video / playlist downloads. yt-dlp itself is replaced by stubs-youtube.cjs, which
// answers with REAL yt-dlp output saved in test/fixtures/yt. Needs a FRESH profile (run-window.ps1).
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
  await until(() => c.ev(`return !!(window.cytto && globalThis.__oliPlayer && window.__fakeYt)`), 40000)
  await sleep(2500)

  // ---------------------------------------------------------------- engine
  const st = await until(async () => {
    const s = await call(c, 'youtube:engine-info')
    return s.state === 'ok' && s.version && s
  }, 15000)
  check('the YouTube engine starts and reports its version', !!st && st.version === '2026.09.20', JSON.stringify(st && { state: st.state, version: st.version, latest: st.latest, message: st.message }))
  const upd = await c.ev(`return window.__fakeYt.calls.filter(x=>x.name==='updateEngine').length`)
  check('a newer yt-dlp was found on GitHub and installed by itself ("update automatically" is on)', upd === 1)
  await c.ev(`window.__fakeYt.engine.latest = '2026.10.05'; return 1`)
  const st2 = await call(c, 'youtube:engine-check')
  check('a later check installs the next release too and says so', st2.state === 'ok' && st2.version === '2026.10.05' && /updated to 2026\.10\.05/.test(st2.message || ''), st2.message)

  // ---------------------------------------------------------------- search
  const online = await c.ev(`
    return await new Promise((resolve) => {
      const off = window.cytto.on('search:online', (p) => { off(); resolve(p) })
      window.cytto.invoke('search:run', 'vinnaithaandi', {}, false)
      setTimeout(() => resolve(null), 20000)
    })`)
  check('searching finds YouTube results (from yt-dlp)', !!online && online.online.some((r) => r.provider === 'youtube' && r.videoId === '4ucog3jt95Q'), online && `${online.online.length} online results, first: ${online.online[0] && online.online[0].title.slice(0, 40)}`)
  await c.ev(`location.hash='#/search'; return 1`)
  await sleep(1200)
  await c.shot(path.join(SHOTS, 'shot-youtube-search.png'))

  // ---------------------------------------------------------------- pasted links
  const one = await call(c, 'youtube:resolve-url', 'https://youtu.be/4ucog3jt95Q?t=3')
  check('a pasted video link becomes one result', one.length === 1 && one[0].videoId === '4ucog3jt95Q' && one[0].artist === 'SonyMusicSouthVEVO', one[0] && one[0].title.slice(0, 40))
  const pl = await call(c, 'youtube:resolve-url', 'https://www.youtube.com/playlist?list=PLabcdefghijk')
  check('a pasted playlist link lists its videos', pl.length === 3 && pl[0].album === 'Harness playlist')
  const entries = await call(c, 'youtube:resolve-playlist-entries', 'https://www.youtube.com/playlist?list=PLabcdefghijk')
  check('playlist entries for the checklist', entries.entries.length === 3 && entries.title === 'Harness playlist' && entries.capped === false)
  const mix = await call(c, 'youtube:resolve-playlist-entries', 'https://www.youtube.com/playlist?list=RDdQw4w9WgXcQ')
  check('a Mix link without a video is explained', /Mix can only be opened/.test(mix.error || ''))
  const notYt = await call(c, 'youtube:resolve-url', 'https://example.com/watch?v=4ucog3jt95Q')
  check('other websites are refused', notYt.length === 0)

  // ---------------------------------------------------------------- playing a YouTube result
  const track = `{id:'youtube:4ucog3jt95Q',title:'Irandaam Ulagam - Vinnaithaandi',artist:'SonyMusicSouthVEVO',artistId:null,albumArtist:'',album:'',albumId:null,path:'',duration:416,codec:null,format:null,bitDepth:null,sampleRate:null,artworkUrl:null,hasEmbeddedArtwork:false}`
  await c.ev(`window.__fakeNative.calls.length = 0; __oliPlayer.getState().playTracks([${track}], 0, {source:'search',sourceId:null}); return 1`)
  const playing = await until(async () => {
    const s = await c.ev(`const s=__oliPlayer.getState(); return {status:s.status,t:s.currentTime}`)
    return s.status === 'playing' && s.t > 1
  }, 40000)
  check('a YouTube result plays (stream address resolved by yt-dlp, played by the native player)', !!playing)
  const load = await c.ev(`return window.__fakeNative.calls.filter(x=>x.name==='loadSource').pop().arg`)
  check('the native player was given the address AND its request headers', /^http/.test(load.url) && load.headers && load.headers['User-Agent'] === 'Harness-UA/1.0', JSON.stringify(load.headers))
  check('...but not the cookie yt-dlp reported', load.headers && !Object.keys(load.headers).some((k) => /cookie/i.test(k)))
  const infoCalls = await c.ev(`return window.__fakeYt.calls.filter(x=>x.name==='info' && x.arg.streams).length`)
  await c.ev(`__oliPlayer.getState().playTracks([${track}], 0, {source:'search',sourceId:null}); return 1`)
  await sleep(2500)
  const infoCalls2 = await c.ev(`return window.__fakeYt.calls.filter(x=>x.name==='info' && x.arg.streams).length`)
  check('playing the same video again reuses the remembered address (no second yt-dlp run)', infoCalls2 === infoCalls, `${infoCalls} -> ${infoCalls2}`)
  await c.ev(`__oliPlayer.getState().toggle && 0; return 1`)

  // ---------------------------------------------------------------- downloads
  await c.ev(`window.__fakeYt.throttleMs = 80; window.__fakeYt.calls.length = 0; return 1`)
  const item = await call(c, 'downloads:enqueue', 'https://youtu.be/4ucog3jt95Q', '')
  check('a pasted YouTube link is queued as a song download', item && item.state === 'queued' && /YouTube song|Vinnaithaandi/.test(item.title), item && item.title)
  const enq = await until(async () => c.ev(`return window.__fakeYt.calls.find(x=>x.name==='enqueue')`), 15000)
  check("its tags were read first and handed to yt-dlp for embedding", !!enq && enq.arg.mode === 'song' && enq.arg.title && enq.arg.artist && /\[4ucog3jt95Q\]$/.test(enq.arg.relBase), enq && JSON.stringify({ title: enq.arg.title, artist: enq.arg.artist, relBase: enq.arg.relBase.slice(0, 50) }))
  const running = await until(async () => (await downloads(c)).find((d) => d.state === 'downloading' && d.progress > 0.05))
  check('progress shows on the Downloads screen', !!running, running && `${(running.progress * 100).toFixed(0)}%`)
  await call(c, 'downloads:pause', running.id)
  const paused = await until(async () => (await downloads(c)).find((d) => d.id === running.id && d.state === 'paused'), 8000)
  check('pause stops the yt-dlp download', !!paused)
  await c.ev(`window.__fakeYt.throttleMs = 0; return 1`)
  await call(c, 'downloads:resume', running.id)
  const done = await until(async () => (await downloads(c)).find((d) => d.id === running.id && d.state === 'completed'), 30000)
  check('resume finishes it', !!done)
  const songs = (await call(c, 'library:songs', {})).tracks
  const made = songs.find((s) => s.path.includes('[4ucog3jt95Q]'))
  check('the finished file became a song with the tags that were sent', !!made && made.title === enq.arg.title && made.artist === enq.arg.artist, made && `${made.artist} - ${made.title}`)
  check('...and its real format was read from the file', !!made && made.sampleRate > 0, made && `${made.format} ${made.sampleRate} Hz`)

  const pdl = await call(c, 'downloads:enqueue-playlist', 'https://www.youtube.com/playlist?list=PLabcdefghijk', 'best')
  check('a whole playlist can be queued', pdl.found === 3 && pdl.enqueued === 3, JSON.stringify(pdl))
  const vid = await call(c, 'video:download', 'AAAAAAAAAAA', 720, 'm4a')
  check('a video download is queued (mp4 up to 720p)', typeof vid === 'string')
  const vspec = await until(async () => c.ev(`return window.__fakeYt.calls.find(x=>x.name==='enqueue' && x.arg.videoId==='AAAAAAAAAAA')`), 10000)
  check('...with the height and audio choice', !!vspec && vspec.arg.mode === 'video' && vspec.arg.height === 720 && vspec.arg.audio === 'm4a' && /Oli\/Videos\//.test(vspec.arg.relBase), vspec && vspec.arg.relBase)
  const allDone = await until(async () => {
    const l = await downloads(c)
    return l.length >= 5 && l.every((d) => d.state === 'completed') && l
  }, 60000)
  check('everything finishes', !!allDone, (await downloads(c)).map((d) => d.state).join(','))
  const songs2 = (await call(c, 'library:songs', {})).tracks
  // the playlist contains the video downloaded a moment ago: same video id = same file name = one song, not two
  check('playlist songs became songs (a video downloaded twice is one file), the video did not', songs2.filter((s) => s.path.includes('/YouTube/')).length === 3 && !songs2.some((s) => s.path.includes('AAAAAAAAAAA')), `${songs2.filter((s) => s.path.includes('/YouTube/')).length} YouTube songs`)

  // cancel one
  await c.ev(`window.__fakeYt.throttleMs = 120; return 1`)
  const cid = await call(c, 'video:download-song', 'BBBBBBBBBBB', 'best')
  const started = await until(async () => (await downloads(c)).find((d) => d.id === cid && d.state === 'downloading'), 15000)
  await call(c, 'downloads:cancel', cid)
  await sleep(1500)
  const gone = (await downloads(c)).find((d) => d.id === cid)
  check('cancel stops a YouTube download and removes its partial file', !!started && gone.state === 'canceled' && !fs.readdirSync(path.join(os.tmpdir(), 'oli-harness-files', 'Oli', 'YouTube')).some((n) => n.includes('BBBBBBBBBBB') && n.endsWith('.part')))

  // engine failure while playing
  await c.ev(`window.__fakeYt.failStreams = true; return 1`)
  const fail = await call(c, 'youtube:resolve-stream', 'CCCCCCCCCCC', true)
  check('when yt-dlp is refused (bot check) the answer is empty, not a crash', Array.isArray(fail) && fail.length === 0)

  await c.ev(`location.hash='#/downloads'; return 1`)
  await sleep(1200)
  await c.shot(path.join(SHOTS, 'shot-youtube-downloads.png'))
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
