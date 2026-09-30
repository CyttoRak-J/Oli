// Downloads a published release and checks it: every installer / disk image / zip / APK against the release's own
// SHA256SUMS file, and for an APK also what is inside (the classes of the app, native libraries, and that no test hook shipped).
//   node scripts/verify-release.mjs <tag>       e.g.  node scripts/verify-release.mjs v1.1.1     or   android-v0.9.1
// Exit code 0 = everything matches. Nothing is installed; files go to a temp folder that is removed at the end.
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, createWriteStream, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'

const REPO = 'CyttoRak-J/Oli'
const tag = process.argv[2]
if (!tag) {
  console.error('usage: node scripts/verify-release.mjs <tag>')
  process.exit(2)
}
const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'oli-release' }
const rel = await (await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, { headers })).json()
if (!rel.assets) {
  console.error('no such release:', tag, rel.message ?? '')
  process.exit(1)
}
console.log(`${rel.tag_name}: ${rel.prerelease ? 'pre-release' : 'release'}${rel.draft ? ', DRAFT' : ''}, ${rel.assets.length} files`)

const dir = mkdtempSync(join(tmpdir(), 'oli-verify-'))
const download = async (asset) => {
  const file = join(dir, asset.name)
  const res = await fetch(asset.browser_download_url)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file))
  return file
}
let bad = 0
const sums = new Map()
for (const a of rel.assets.filter((x) => /^SHA256SUMS.*\.txt$/.test(x.name))) {
  for (const line of readFileSync(await download(a), 'utf8').split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim())
    if (m) sums.set(m[2], m[1])
  }
}
for (const a of rel.assets.filter((x) => /\.(exe|dmg|zip|apk)$/.test(x.name))) {
  const file = await download(a)
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex')
  const want = sums.get(a.name)
  const ok = want === hash
  if (!ok) bad++
  console.log(`  ${ok ? 'OK ' : 'BAD'}  ${a.name}  ${(a.size / 1e6).toFixed(1)} MB${want ? '' : '  (no checksum listed)'}`)
  if (ok && a.name.endsWith('.apk')) await inspectApk(file)
}
rmSync(dir, { recursive: true, force: true })
process.exit(bad ? 1 : 0)

async function inspectApk(file) {
  let yauzl
  try {
    yauzl = createRequire(import.meta.url)('yauzl')
  } catch {
    console.log('        (yauzl not installed: APK contents not inspected)')
    return
  }
  const zip = await new Promise((res, rej) => yauzl.open(file, { lazyEntries: true, autoClose: false }, (e, z) => (e ? rej(e) : res(z))))
  const names = []
  const dex = []
  const web = []
  await new Promise((resolve, reject) => {
    zip.on('entry', (entry) => {
      names.push(entry.fileName)
      const want = /\.dex$/.test(entry.fileName) || /^assets\/public\/assets\/.*\.js$/.test(entry.fileName)
      if (!want) return zip.readEntry()
      zip.openReadStream(entry, (e, stream) => {
        if (e) return reject(e)
        const chunks = []
        stream.on('data', (c) => chunks.push(c))
        stream.on('end', () => {
          ;(entry.fileName.endsWith('.dex') ? dex : web).push(Buffer.concat(chunks))
          zip.readEntry()
        })
      })
    })
    zip.on('end', resolve)
    zip.on('error', reject)
    zip.readEntry()
  })
  const inDex = (s) => dex.some((b) => b.includes(s))
  const inWeb = (s) => web.some((b) => b.includes(s))
  const abis = [...new Set(names.filter((n) => n.startsWith('lib/')).map((n) => n.split('/')[1]))]
  const classes = ['OliAudioService', 'OliMediaPlugin', 'OliDownloadService', 'OliYouTubePlugin', 'FlacPicture', 'FolderScope']
  console.log(`        classes: ${classes.map((c) => `${c} ${inDex(c) ? 'yes' : 'NO'}`).join(', ')}`)
  console.log(`        native libraries: ${abis.join(', ') || 'none'}`)
  const hook = inWeb('__oliPlayer') || inWeb('__fakeNative')
  console.log(`        test hook shipped: ${hook ? 'YES (bad)' : 'no'}`)
  if (hook || classes.some((c) => !inDex(c))) bad++
}
