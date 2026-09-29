// Throwaway Electron shell for testing the phone build on the PC. Not part of the app.
// usage: electron main.cjs <bundleDir> <userDataDir> <debugPort>
const { app, BrowserWindow } = require('electron')
const http = require('http')
const fs = require('fs')
const path = require('path')

const [bundleDir, userData, debugPort] = process.argv.slice(2)
app.setPath('userData', userData)
app.commandLine.appendSwitch('remote-debugging-port', debugPort || '9333')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.flac': 'audio/flac', '.mp3': 'audio/mpeg' }
const FLAC_ROOT = 'A:\\Flac\\'

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0])
  let file
  if (url.startsWith('/file/')) {
    file = url.slice('/file/'.length).replace(/\//g, '\\')
    if (!file.toLowerCase().startsWith(FLAC_ROOT.toLowerCase())) {
      res.writeHead(403).end()
      return
    }
  } else {
    file = path.join(bundleDir, url === '/' ? 'index.html' : url)
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }).end()
      return
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range)
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' }
    if (range) {
      const start = range[1] ? parseInt(range[1], 10) : 0
      const end = range[2] ? parseInt(range[2], 10) : st.size - 1
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 })
      fs.createReadStream(file, { start, end }).pipe(res)
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': st.size })
      fs.createReadStream(file).pipe(res)
    }
  })
})

app.whenReady().then(() => {
  server.listen(8765, '127.0.0.1', () => {
    const win = new BrowserWindow({
      width: 390,
      height: 800,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: false, nodeIntegration: false, sandbox: false }
    })
    win.loadURL('http://127.0.0.1:8765/')
  })
})
app.on('window-all-closed', () => app.quit())
