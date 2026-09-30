// The real Now Playing seek bar: a mouse click and a finger tap on the bar must reach the native player as seekTo.
const { connect, sleep } = require('./drive.cjs')
const HI = 'A:/Flac'
;(async () => {
  const c = await connect()
  await c.ev(`window.confirm = () => true; return 1`)
  const files = await c.ev(`return 1`)
  const song = process.argv[2]
  const tr = `{id:'s1',title:'S',artist:'A',album:'B',path:'file:///${song}',duration:200,codec:'flac',format:'FLAC',bitDepth:16,sampleRate:44100,artworkUrl:null,hasEmbeddedArtwork:false}`
  await c.ev(`window.__fakeNative.calls.length=0; __oliPlayer.getState().playTracks([${tr}],0,{source:'library',sourceId:null}); return 1`)
  await sleep(4000)
  console.log('state', JSON.stringify(await c.ev('const s=__oliPlayer.getState(); return {st:s.status,t:s.currentTime,d:s.duration}')))
  await c.ev(`document.querySelector('[aria-label="Now playing"]').click(); return 1`)
  await sleep(800)
  const r = await c.ev(`const r=document.querySelector('[aria-label="Seek"]').getBoundingClientRect(); return {x:r.left,y:r.top+r.height/2,w:r.width,max:document.querySelector('[aria-label="Seek"]').max}`)
  console.log('slider', JSON.stringify(r))
  const seeks = () => c.ev(`return window.__fakeNative.calls.filter(c=>c.name==='seekTo').map(c=>c.arg.positionMs)`)
  const x = r.x + r.w * 0.5
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y: r.y, button: 'left', clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: r.y, button: 'left', clickCount: 1 })
  await sleep(800)
  console.log('after mouse click:', JSON.stringify(await seeks()), 'state', JSON.stringify(await c.ev(`const s=__oliPlayer.getState(); return {t:s.currentTime,st:s.status}`)))
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: true })
  const x2 = r.x + r.w * 0.8
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x2, y: r.y }] })
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(800)
  console.log('after touch tap:', JSON.stringify(await seeks()), 'state', JSON.stringify(await c.ev(`const s=__oliPlayer.getState(); return {t:s.currentTime,st:s.status}`)))
  // a finger drag from 10% to 30%
  const xa = r.x + r.w * 0.1, xb = r.x + r.w * 0.3
  const before = (await seeks()).length
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: xa, y: r.y }] })
  for (let k = 1; k <= 6; k++) await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: xa + (xb - xa) * k / 6, y: r.y }] })
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(800)
  const after = await seeks()
  console.log('after touch drag 10%->30% (expect ~26400 ms):', JSON.stringify(after.slice(before)))
  // the browser cancelling a touch at its very start (no movement) must not seek
  const n2 = after.length
  await c.ev("const el=document.querySelector('[aria-label=\"Seek\"]'); el.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true})); return 1")
  await sleep(500)
  console.log('after a cancelled touch without movement (expect no new seek):', (await seeks()).length - n2, 'new seeks')
  c.close()
  process.exit(0)
})()
