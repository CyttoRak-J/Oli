// Writes every file that is embedded in BUILD_FROM_SCRATCH.md (Part II: the complete source) into a folder.
//   node extract-spec.mjs <BUILD_FROM_SCRATCH.md> <output folder>
// Needs only Node 18 or newer. A file is a heading line followed by a fenced block:
//   #### FILE: path                    text file (LF line ends, ends with a newline)
//   #### FILE (no-eol): path           text file without a final newline
//   #### FILE (crlf): path             text file with Windows line ends (also: "crlf,no-eol")
//   #### FILE (base64): path           binary file, base64 in the block
// The fence is as many backticks as needed (one more than the longest run inside the file).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

const [spec, outDir] = process.argv.slice(2)
if (!spec || !outDir) {
  console.error('usage: node extract-spec.mjs <BUILD_FROM_SCRATCH.md> <output folder>')
  process.exit(2)
}
const lines = readFileSync(spec, 'utf8').replace(/\r\n/g, '\n').split('\n')
const root = resolve(outDir)
let count = 0
for (let i = 0; i < lines.length; i++) {
  const head = /^#### FILE(?: \(([a-z0-9,-]+)\))?: (.+)$/.exec(lines[i])
  if (!head) continue
  const open = /^(`{3,})[\w-]*$/.exec(lines[i + 1] ?? '')
  if (!open) throw new Error(`line ${i + 1}: no code block after "${lines[i]}"`)
  let end = i + 2
  while (end < lines.length && lines[end] !== open[1]) end++
  if (end >= lines.length) throw new Error(`line ${i + 1}: the block of ${head[2]} is not closed`)
  const body = lines.slice(i + 2, end)
  const target = resolve(root, head[2])
  if (target !== root && !target.startsWith(root + sep)) throw new Error(`refusing to write outside the folder: ${head[2]}`)
  mkdirSync(dirname(target), { recursive: true })
  const flags = (head[1] ?? '').split(',')
  if (flags.includes('base64')) {
    writeFileSync(target, Buffer.from(body.join(''), 'base64'))
  } else {
    let text = body.join('\n') + (flags.includes('no-eol') ? '' : '\n')
    if (flags.includes('crlf')) text = text.replace(/\n/g, '\r\n')
    writeFileSync(target, text, 'utf8')
  }
  count++
  i = end
}
console.log(`wrote ${count} files into ${join(root)}`)
