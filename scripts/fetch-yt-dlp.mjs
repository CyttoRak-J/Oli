// Downloads the yt-dlp binary into bin/, matching the platform Electron is
// running on. provider.ts looks for it at bin/yt-dlp(.exe) and silently
// no-ops YouTube resolution when it's missing — this script is what's
// supposed to put it there (electron-builder.yml already packages bin/ as
// an extraResource, but nothing was ever fetching it).
import { createWriteStream, mkdirSync, chmodSync, existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const binDir = path.join(__dirname, '..', 'bin')

const ASSET_BY_PLATFORM = {
  win32: 'yt-dlp.exe',
  darwin: 'yt-dlp_macos',
  linux: 'yt-dlp_linux'
}

const OUTPUT_NAME_BY_PLATFORM = {
  win32: 'yt-dlp.exe',
  darwin: 'yt-dlp',
  linux: 'yt-dlp'
}

async function main() {
  const asset = ASSET_BY_PLATFORM[process.platform]
  const outName = OUTPUT_NAME_BY_PLATFORM[process.platform]
  if (!asset) {
    console.error(`No yt-dlp release asset mapped for platform "${process.platform}".`)
    process.exit(1)
  }

  mkdirSync(binDir, { recursive: true })
  const outPath = path.join(binDir, outName)

  if (existsSync(outPath) && !process.argv.includes('--force')) {
    console.log(`bin/${outName} already exists, skipping (use --force to re-download).`)
    return
  }

  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`
  console.log(`Downloading ${url} ...`)

  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`)
  }

  const tmpPath = `${outPath}.download`
  await pipeline(res.body, createWriteStream(tmpPath))

  // Verify against the checksums published with the release before use.
  const sums = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS', {
    redirect: 'follow'
  })
  if (!sums.ok) {
    rmSync(tmpPath, { force: true })
    throw new Error(`Could not fetch checksums: ${sums.status} ${sums.statusText}`)
  }
  const expected = (await sums.text())
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .find(([, name]) => name?.replace(/^\*/, '') === asset)?.[0]
  const actual = createHash('sha256').update(readFileSync(tmpPath)).digest('hex')
  if (!expected || expected !== actual) {
    rmSync(tmpPath, { force: true })
    throw new Error(`Checksum mismatch for ${asset} (expected ${expected}, got ${actual}); not installed.`)
  }
  renameSync(tmpPath, outPath)

  if (process.platform !== 'win32') {
    chmodSync(outPath, 0o755)
  }

  console.log(`Saved to bin/${outName}`)
  console.log('Also make sure ffmpeg is available (yt-dlp needs it to mux/extract audio);')
  console.log('either put an ffmpeg(.exe) binary in bin/ too, or have it on PATH.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
