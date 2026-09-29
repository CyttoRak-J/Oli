import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// FlacPicture.java (the cover inside a FLAC file, for songs where Android's own reader finds none) is plain Java: compile
// it with the PC's JDK. The FLAC files with a cover are made by the app's own tag writer.
const hasJdk = spawnSync('javac', ['-version']).status === 0
const repo = path.resolve(__dirname, '..')
const javaDir = path.join(repo, 'android/app/src/main/java/com/cyttos/oli')
let work = ''
let out = ''

function makeFlac(): Buffer {
  const info = Buffer.alloc(34)
  info.writeUInt16BE(4096, 0)
  info.writeUInt16BE(4096, 2)
  info[10] = (44100 >> 12) & 0xff
  info[11] = (44100 >> 4) & 0xff
  info[12] = ((44100 & 0xf) << 4) | (1 << 1)
  info[13] = 15 << 4
  const padding = Buffer.alloc(300)
  return Buffer.concat([
    Buffer.from('fLaC'),
    Buffer.from([0x00, 0, 0, 34]),
    info,
    Buffer.from([0x81, 0, (300 >> 8) & 0xff, 300 & 0xff]),
    padding,
    crypto.randomBytes(50_000)
  ])
}

const tag = (file: string, ...pairs: string[]): string => {
  const argFile = path.join(work, `args-${Math.random().toString(36).slice(2)}.txt`)
  fs.writeFileSync(argFile, pairs.join('\n'), 'utf8')
  return execFileSync('java', ['-cp', out, 'com.cyttos.oli.TagCli', file, `@${argFile}`], { encoding: 'utf8' }).trim()
}
const pic = (file: string, dest: string): string => execFileSync('java', ['-cp', out, 'com.cyttos.oli.PicCli', file, dest], { encoding: 'utf8' }).trim()

describe.skipIf(!hasJdk)('cover picture inside a FLAC file (compiled with the PC JDK)', () => {
  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'oli-flacpic-'))
    out = path.join(work, 'classes')
    fs.mkdirSync(out)
    execFileSync('javac', [
      '-d',
      out,
      path.join(javaDir, 'TagFields.java'),
      path.join(javaDir, 'FlacTagWriter.java'),
      path.join(javaDir, 'Id3TagWriter.java'),
      path.join(javaDir, 'FlacPicture.java'),
      path.join(repo, 'scripts/android-tags/com/cyttos/oli/TagCli.java'),
      path.join(repo, 'scripts/android-tags/com/cyttos/oli/PicCli.java')
    ])
  })
  afterAll(() => fs.rmSync(work, { recursive: true, force: true }))

  it('finds the picture the tag writer embedded, byte for byte', () => {
    const file = path.join(work, 'a.flac')
    fs.writeFileSync(file, makeFlac())
    const cover = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(5000), Buffer.from([0xff, 0xd9])])
    const coverFile = path.join(work, 'cover.jpg')
    fs.writeFileSync(coverFile, cover)
    expect(tag(file, 'title=T', `cover=${coverFile}`)).toBe('written')
    const dest = path.join(work, 'got.jpg')
    expect(pic(file, dest)).toBe(String(cover.length))
    expect(fs.readFileSync(dest).equals(cover)).toBe(true)
  })

  it('says none for a FLAC file without a picture, and for a file that is not FLAC', () => {
    const file = path.join(work, 'b.flac')
    fs.writeFileSync(file, makeFlac())
    expect(pic(file, path.join(work, 'x.jpg'))).toBe('none')
    const junk = path.join(work, 'c.flac')
    fs.writeFileSync(junk, crypto.randomBytes(2000))
    expect(pic(junk, path.join(work, 'y.jpg'))).toBe('none')
    const tiny = path.join(work, 'd.flac')
    fs.writeFileSync(tiny, Buffer.from('fLa'))
    expect(pic(tiny, path.join(work, 'z.jpg'))).toBe('none')
  })
})
