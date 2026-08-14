// Renders the app icon (Brahmi glyph 𑀧𑀸) to build/icon.png and the tray
// icons by rasterizing SVG pages through the project's own Chromium/Electron.
// Run once; the PNGs are baked into the app, so end-user machines don't need
// a Brahmi-capable font.
import { spawn } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync, mkdirSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const mainJs = join(here, 'electron-icon-main.cjs')

const electronBin = process.platform === 'win32'
  ? join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  : join(root, 'node_modules', '.bin', 'electron')

const out = join(root, 'build')
mkdirSync(out, { recursive: true })
for (const f of ['icon.png', 'tray-16.png', 'tray-32.png']) {
  rmSync(join(out, f), { force: true })
}

const child = spawn(electronBin, [mainJs], { cwd: root, stdio: 'inherit' })
child.on('exit', (code) => {
  process.exit(code ?? 1)
})