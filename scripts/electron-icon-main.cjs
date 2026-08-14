const { app, BrowserWindow, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const GLYPH = '\u{11027}\u{11102}' // ð‘€§ð‘€¸ (Brahmi "paa")

const DRAW = `
(function () {
  const size = 1024
  const GLYPH = '\\u{11027}\\u{11102}'
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')

  function roundedRect(x, y, w, h, r) {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
  }

  function drawGlyphCentered(fontSize, fill) {
    const scratch = document.createElement('canvas')
    scratch.width = size
    scratch.height = size
    const sctx = scratch.getContext('2d')
    sctx.fillStyle = fill
    sctx.font = '600 ' + fontSize + 'px "Nirmala UI", "Segoe UI Symbol", sans-serif'
    sctx.textAlign = 'left'
    sctx.textBaseline = 'alphabetic'
    const m = sctx.measureText(GLYPH)
    let x = 512 - m.actualBoundingBoxLeft - (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2
    let y = 512 + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2
    for (let i = 0; i < 5; i++) {
      sctx.clearRect(0, 0, size, size)
      sctx.fillText(GLYPH, x, y)
      const d = sctx.getImageData(0, 0, size, size).data
      let minX = size, maxX = -1, minY = size, maxY = -1
      for (let py = 0; py < size; py += 2) {
        for (let px = 0; px < size; px += 2) {
          const j = (py * size + px) * 4
          if (d[j + 3] > 100 && (d[j] + d[j + 1] + d[j + 2]) > 300) {
            if (px < minX) minX = px
            if (px > maxX) maxX = px
            if (py < minY) minY = py
            if (py > maxY) maxY = py
          }
        }
      }
      if (minX > maxX) throw new Error('glyph ink not found')
      const dx = 512 - (minX + maxX) / 2
      const dy = 512 - (minY + maxY) / 2
      x += dx
      y += dy
      if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) break
    }
    sctx.clearRect(0, 0, size, size)
    sctx.fillText(GLYPH, x, y)
    ctx.drawImage(scratch, 0, 0)
  }

  function drawIcon() {
    ctx.clearRect(0, 0, size, size)
    roundedRect(56, 56, 912, 912, 208)
    const tint = ctx.createLinearGradient(0, 0, 0, 1024)
    tint.addColorStop(0, '#1E2231')
    tint.addColorStop(1, '#10121A')
    ctx.fillStyle = tint
    ctx.fill()

    const glow = ctx.createRadialGradient(512, 410, 0, 512, 512, 800)
    glow.addColorStop(0, 'rgba(124,58,237,0.55)')
    glow.addColorStop(0.55, 'rgba(124,58,237,0.15)')
    glow.addColorStop(1, 'rgba(124,58,237,0)')
    ctx.fillStyle = glow
    ctx.fill()

    ctx.strokeStyle = 'rgba(139,92,246,0.38)'
    ctx.lineWidth = 12
    ctx.stroke()

    drawGlyphCentered(620, '#F1ECFF')
  }

  function drawTray() {
    ctx.clearRect(0, 0, size, size)
    drawGlyphCentered(800, '#B79CFF')
  }

  drawIcon()
  const iconData = canvas.toDataURL('image/png')
  drawTray()
  const trayData = canvas.toDataURL('image/png')
  return JSON.stringify({ iconData, trayData })
})()
`

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    webPreferences: { backgroundThrottling: false }
  })
  win.webContents.on('console-message', (e, level, msg) => {
    if (typeof msg === 'string' && !msg.includes('Security Warning')) console.log('page:', msg)
  })
  try {
    const html = '<!doctype html><html><body></body></html>'
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    const code = DRAW
    const { iconData, trayData } = JSON.parse(await win.webContents.executeJavaScript(code))

    const build = path.join(ROOT, 'build')
    fs.mkdirSync(build, { recursive: true })

    const icon = nativeImage.createFromDataURL(iconData)
    const tray = nativeImage.createFromDataURL(trayData)
    if (icon.isEmpty() || tray.isEmpty()) throw new Error('empty image from canvas')

    fs.writeFileSync(path.join(build, 'icon.png'), icon.toPNG())
    fs.writeFileSync(path.join(build, 'tray-32.png'), tray.resize({ width: 32, height: 32, quality: 'best' }).toPNG())
    fs.writeFileSync(path.join(build, 'tray-16.png'), tray.resize({ width: 16, height: 16, quality: 'best' }).toPNG())
    console.log('icons written')
    app.exit(0)
  } catch (err) {
    console.error('icon render failed', err)
    app.exit(1)
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
})
