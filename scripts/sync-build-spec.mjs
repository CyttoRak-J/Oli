// Keeps the "(verbatim)" code blocks of BUILD_FROM_SCRATCH.md equal to the real source files.
//   node scripts/sync-build-spec.mjs          check: lists blocks that differ from their file (exit 1 if any)
//   node scripts/sync-build-spec.mjs --fix    rewrite the differing blocks from the files
// Each entry below names the line of the spec that introduces a block and the file the block must contain. The block is the
// first fenced code block after that line (or the nth, when a third value is given).
import { readFileSync, writeFileSync } from 'node:fs'

const SPEC = 'BUILD_FROM_SCRATCH.md'
const BLOCKS = [
  ['### 5.1 package.json (verbatim)', 'package.json'],
  ['### 5.2 electron.vite.config.ts (verbatim)', 'electron.vite.config.ts'],
  ['### 5.3 tsconfig.json and tsconfig.node.json (verbatim)', 'tsconfig.json', 0],
  ['### 5.3 tsconfig.json and tsconfig.node.json (verbatim)', 'tsconfig.node.json', 1],
  ['### 5.4 vitest.config.ts and eslint.config.js (verbatim)', 'vitest.config.ts', 0],
  ['### 5.4 vitest.config.ts and eslint.config.js (verbatim)', 'eslint.config.js', 1],
  ['### 5.5 electron-builder.yml (verbatim)', 'electron-builder.yml'],
  ['### 5.7 scripts/fetch-yt-dlp.mjs (verbatim)', 'scripts/fetch-yt-dlp.mjs'],
  ['### 5.8 CI and release: `.github/workflows/build.yml` (verbatim)', '.github/workflows/build.yml'],
  ['`.github/release-notes.md` (verbatim):', '.github/release-notes.md'],
  ['### 7.1 constants.ts (verbatim)', 'src/shared/constants.ts'],
  ['### 7.2 types.ts (verbatim)', 'src/shared/types.ts'],
  ['### 7.3 ipc.ts: every IPC channel name (verbatim)', 'src/shared/ipc.ts'],
  ['### 7.4 Preload bridge (verbatim)', 'src/preload/index.ts'],
  ['### 8.4 Local audio: MediaServer (verbatim)', 'src/main/services/mediaServer.ts'],
  ['`.github/workflows/android.yml` (verbatim)', '.github/workflows/android.yml'],
  ['`.github/android-release-notes.md` (verbatim):', '.github/android-release-notes.md'],
  ['The web backend (verbatim):', 'src/renderer/src/platform/webBackend.ts']
]

const fix = process.argv.includes('--fix')
let lines = readFileSync(SPEC, 'utf8').replace(/\r\n/g, '\n').split('\n')
let differing = 0
for (const [marker, file, nth = 0] of BLOCKS) {
  const at = lines.findIndex((l) => l.startsWith(marker))
  if (at < 0) {
    console.log(`MISSING MARKER  ${marker}`)
    differing++
    continue
  }
  // the nth fenced block after the marker (fences alternate: open, close, open, close ...)
  let open = at
  for (let k = 0; k <= nth; k++) {
    open++
    while (open < lines.length && !lines[open].startsWith('```')) open++
    if (k < nth) {
      open++
      while (open < lines.length && !lines[open].startsWith('```')) open++
    }
  }
  let close = open + 1
  while (close < lines.length && !lines[close].startsWith('```')) close++
  let block = lines.slice(open + 1, close)
  const real = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\s+$/, '')
  // the spec may head a block with "// path/to/file" (a label that is not in the file itself): keep it
  const label = block.length > 0 && /^\/\/ \S+\.\w+$/.test(block[0]) && !real.startsWith(block[0]) ? block[0] : null
  if (label) block = block.slice(1)
  const inSpec = block.join('\n').replace(/\s+$/, '')
  if (inSpec === real) {
    console.log(`same     ${file}`)
    continue
  }
  differing++
  console.log(`${fix ? 'updated ' : 'DIFFERS '} ${file}   (spec ${inSpec.split('\n').length} lines, file ${real.split('\n').length} lines)`)
  if (fix) lines = [...lines.slice(0, open + 1), ...(label ? [label] : []), ...real.split('\n'), ...lines.slice(close)]
}
if (fix) writeFileSync(SPEC, lines.join('\n'))
process.exit(differing > 0 && !fix ? 1 : 0)
