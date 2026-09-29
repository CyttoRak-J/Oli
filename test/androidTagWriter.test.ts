import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import NodeID3 from 'node-id3'
import { parseFile } from 'music-metadata'

// The Android tag writers (FlacTagWriter / Id3TagWriter) are plain Java: compile them with the PC's JDK and check
// their output with an independent reader (music-metadata). Skipped when no JDK is installed.
const hasJdk = spawnSync('javac', ['-version']).status === 0
const repo = path.resolve(__dirname, '..')
const javaDir = path.join(repo, 'android/app/src/main/java/com/cyttos/oli')

let work = ''
let out = ''

const sha = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex')

let argSeq = 0
/** The tag values go through a UTF-8 file (non-ASCII text cannot travel on a Windows command line). */
function run(file: string, ...args: string[]): string {
  const argFile = path.join(work, `args-${++argSeq}.txt`)
  fs.writeFileSync(argFile, args.join(String.fromCharCode(10)), 'utf8')
  return execFileSync('java', ['-cp', out, 'com.cyttos.oli.TagCli', file, `@${argFile}`], { encoding: 'utf8' }).trim()
}

/** A tiny but valid FLAC layout: STREAMINFO + PADDING + "audio" bytes (music-metadata reads tags from the blocks). */
function makeFlac(): { buf: Buffer; audioOffset: number } {
  const info = Buffer.alloc(34)
  info.writeUInt16BE(4096, 0)
  info.writeUInt16BE(4096, 2)
  const sr = 96000
  const ch = 2
  const bps = 24
  const total = sr * 10
  // 20 bits rate | 3 bits channels-1 | 5 bits bps-1 | 36 bits samples
  info[10] = (sr >> 12) & 0xff
  info[11] = (sr >> 4) & 0xff
  info[12] = ((sr & 0xf) << 4) | ((ch - 1) << 1) | (((bps - 1) >> 4) & 1)
  info[13] = (((bps - 1) & 0xf) << 4) | ((total / 2 ** 32) & 0xf)
  info.writeUInt32BE(total >>> 0, 14)
  const padding = Buffer.alloc(300)
  const head = Buffer.concat([
    Buffer.from('fLaC'),
    Buffer.from([0x00, 0, 0, 34]),
    info,
    Buffer.from([0x81, 0, (300 >> 8) & 0xff, 300 & 0xff]),
    padding
  ])
  const audio = crypto.randomBytes(200_000)
  return { buf: Buffer.concat([head, audio]), audioOffset: head.length }
}

/** Where the audio starts in a FLAC file (after the last metadata block). */
function flacAudioOffset(b: Buffer): number {
  let o = 4
  for (;;) {
    const last = (b[o] & 0x80) !== 0
    const len = (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]
    o += 4 + len
    if (last) return o
  }
}

/** A JPEG-looking picture (the writers only copy the bytes) with a real SOF marker for the size. */
function fakeJpeg(w: number, h: number): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0, 17, 8, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, crypto.randomBytes(3000), Buffer.from([0xff, 0xd9])])
}

function makeMp3Audio(frames = 60): Buffer {
  const frame = Buffer.alloc(417)
  frame.set([0xff, 0xfb, 0x90, 0x00])
  return Buffer.concat(Array.from({ length: frames }, () => frame))
}

describe.skipIf(!hasJdk)('Android tag writers (compiled with the PC JDK)', () => {
  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'oli-tagw-'))
    out = path.join(work, 'classes')
    fs.mkdirSync(out)
    execFileSync('javac', [
      '-d',
      out,
      path.join(javaDir, 'TagFields.java'),
      path.join(javaDir, 'FlacTagWriter.java'),
      path.join(javaDir, 'Id3TagWriter.java'),
      path.join(repo, 'scripts/android-tags/com/cyttos/oli/TagCli.java')
    ])
  })
  afterAll(() => fs.rmSync(work, { recursive: true, force: true }))

  it('FLAC: writes all tags and a cover, audio bytes stay identical', async () => {
    const { buf, audioOffset } = makeFlac()
    const file = path.join(work, 'a.flac')
    fs.writeFileSync(file, buf)
    const coverFile = path.join(work, 'cover.jpg')
    const jpeg = fakeJpeg(600, 400)
    fs.writeFileSync(coverFile, jpeg)

    expect(
      run(file, 'title=Vinnaithaandi', 'artist=Harris Jayaraj', 'albumArtist=Various', 'album=Irandaam Ulagam', 'genre=Soundtrack', 'composer=HJ',
        'isrc=INA000000001', 'track=7', 'disc=2', 'year=2013', 'lyrics=la la', `cover=${coverFile}`)
    ).toBe('written')

    const after = fs.readFileSync(file)
    expect(sha(after.subarray(flacAudioOffset(after)))).toBe(sha(buf.subarray(audioOffset)))
    const meta = await parseFile(file)
    expect(meta.common.title).toBe('Vinnaithaandi')
    expect(meta.common.artist).toBe('Harris Jayaraj')
    expect(meta.common.albumartist).toBe('Various')
    expect(meta.common.album).toBe('Irandaam Ulagam')
    expect(meta.common.genre).toEqual(['Soundtrack'])
    expect(meta.common.composer).toEqual(['HJ'])
    expect(meta.common.isrc).toEqual(['INA000000001'])
    expect(meta.common.track.no).toBe(7)
    expect(meta.common.disk.no).toBe(2)
    expect(meta.common.year).toBe(2013)
    expect(meta.common.picture?.[0].format).toBe('image/jpeg')
    expect(Buffer.from(meta.common.picture![0].data).equals(jpeg)).toBe(true)
    expect(meta.format.sampleRate).toBe(96000)
    expect(meta.format.bitsPerSample).toBe(24)
  })

  it('FLAC: a second write changes only what it is given and keeps the cover', async () => {
    const file = path.join(work, 'a.flac')
    const before = fs.readFileSync(file)
    expect(run(file, 'title=New title', 'genre=')).toBe('written')
    const after = fs.readFileSync(file)
    expect(sha(after.subarray(flacAudioOffset(after)))).toBe(sha(before.subarray(flacAudioOffset(before))))
    const meta = await parseFile(file)
    expect(meta.common.title).toBe('New title')
    expect(meta.common.artist).toBe('Harris Jayaraj')
    expect(meta.common.genre).toBeUndefined() // an empty value removes the tag
    expect(meta.common.picture).toHaveLength(1)
    expect(meta.common.track.no).toBe(7)
  })

  it('FLAC: no temporary file is left behind and a non-FLAC file is refused untouched', () => {
    expect(fs.readdirSync(work).filter((n) => n.endsWith('.tagging'))).toEqual([])
    const bad = path.join(work, 'fake.flac')
    fs.writeFileSync(bad, Buffer.from('this is not a flac file at all'))
    expect(run(bad, 'title=x')).toBe('unsupported')
    expect(fs.readFileSync(bad, 'utf8')).toBe('this is not a flac file at all')
  })

  it('FLAC: keeps unicode text', async () => {
    const { buf } = makeFlac()
    const file = path.join(work, 'u.flac')
    fs.writeFileSync(file, buf)
    run(file, 'title=வின்னைத்தாண்டி வருவாயா', 'artist=ஹாரிஸ் ஜெயராஜ்')
    const meta = await parseFile(file)
    expect(meta.common.title).toBe('வின்னைத்தாண்டி வருவாயா')
    expect(meta.common.artist).toBe('ஹாரிஸ் ஜெயராஜ்')
  })

  it('FLAC: works on a real hi-res file from the library (when present)', async () => {
    const dir = 'A:/Flac'
    if (!fs.existsSync(dir)) return
    const pick = fs
      .readdirSync(dir)
      .filter((n) => n.toLowerCase().endsWith('.flac'))
      .map((n) => ({ n, s: fs.statSync(path.join(dir, n)).size }))
      .filter((x) => x.s < 40 * 1024 * 1024)
      .sort((a, b) => b.s - a.s)[0]
    if (!pick) return
    const file = path.join(work, 'real.flac')
    fs.copyFileSync(path.join(dir, pick.n), file)
    const orig = fs.readFileSync(file)
    const origMeta = await parseFile(file)
    run(file, 'title=Renamed by test', 'track=99')
    const after = fs.readFileSync(file)
    expect(sha(after.subarray(flacAudioOffset(after)))).toBe(sha(orig.subarray(flacAudioOffset(orig))))
    const meta = await parseFile(file)
    expect(meta.common.title).toBe('Renamed by test')
    expect(meta.common.track.no).toBe(99)
    expect(meta.common.artist).toBe(origMeta.common.artist)
    expect(meta.common.album).toBe(origMeta.common.album)
    expect(meta.format.sampleRate).toBe(origMeta.format.sampleRate)
    expect(meta.format.duration).toBeCloseTo(origMeta.format.duration ?? 0, 3)
    expect(meta.common.picture?.length ?? 0).toBe(origMeta.common.picture?.length ?? 0)
  })

  it('MP3 without a tag: a new ID3v2.3 tag with all fields and a cover, audio identical', async () => {
    const audio = makeMp3Audio()
    const file = path.join(work, 'a.mp3')
    fs.writeFileSync(file, audio)
    const coverFile = path.join(work, 'cover2.jpg')
    const jpeg = fakeJpeg(300, 300)
    fs.writeFileSync(coverFile, jpeg)
    expect(run(file, 'title=Song', 'artist=Band', 'album=Record', 'albumArtist=Band', 'genre=Rock', 'composer=Me', 'isrc=X1', 'track=3', 'disc=1', 'year=2020', 'lyrics=hello', `cover=${coverFile}`)).toBe('written')
    const after = fs.readFileSync(file)
    expect(after.subarray(0, 4).toString('latin1')).toBe('ID3\u0003')
    expect(after.subarray(after.length - audio.length).equals(audio)).toBe(true)
    const meta = await parseFile(file)
    expect(meta.common.title).toBe('Song')
    expect(meta.common.artist).toBe('Band')
    expect(meta.common.album).toBe('Record')
    expect(meta.common.albumartist).toBe('Band')
    expect(meta.common.genre).toEqual(['Rock'])
    expect(meta.common.composer).toEqual(['Me'])
    expect(meta.common.track.no).toBe(3)
    expect(meta.common.disk.no).toBe(1)
    expect(meta.common.year).toBe(2020)
    expect(meta.common.lyrics?.[0].text).toBe('hello')
    expect(Buffer.from(meta.common.picture![0].data).equals(jpeg)).toBe(true)
  })

  it('MP3 with an existing tag (made by another library): unchanged frames and the cover survive', async () => {
    const audio = makeMp3Audio()
    const file = path.join(work, 'b.mp3')
    fs.writeFileSync(file, audio)
    const jpeg = fakeJpeg(200, 200)
    NodeID3.write(
      { title: 'Old', artist: 'Band', album: 'Record', genre: 'Rock', image: { mime: 'image/jpeg', type: { id: 3 }, description: '', imageBuffer: jpeg } },
      file
    )
    const tagLen = fs.readFileSync(file).length - audio.length
    expect(run(file, 'title=New', 'track=5')).toBe('written')
    const after = fs.readFileSync(file)
    expect(after.subarray(after.length - audio.length).equals(audio)).toBe(true)
    expect(tagLen).toBeGreaterThan(0)
    const meta = await parseFile(file)
    expect(meta.common.title).toBe('New')
    expect(meta.common.artist).toBe('Band')
    expect(meta.common.album).toBe('Record')
    expect(meta.common.genre).toEqual(['Rock'])
    expect(meta.common.track.no).toBe(5)
    expect(Buffer.from(meta.common.picture![0].data).equals(jpeg)).toBe(true)
    // and the other library can read what we wrote
    const tags = NodeID3.read(file)
    expect(tags.title).toBe('New')
    expect(tags.artist).toBe('Band')
  })

  it('MP3 with an ID3v2.4 tag stays v2.4 and keeps its frames', async () => {
    const audio = makeMp3Audio()
    // hand-made v2.4 tag: TIT2 (UTF-8) + TPE1 (UTF-8)
    const frame = (id: string, text: string): Buffer => {
      const body = Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')])
      const size = Buffer.from([(body.length >> 21) & 0x7f, (body.length >> 14) & 0x7f, (body.length >> 7) & 0x7f, body.length & 0x7f])
      return Buffer.concat([Buffer.from(id, 'ascii'), size, Buffer.from([0, 0]), body])
    }
    const frames = Buffer.concat([frame('TIT2', 'Töne'), frame('TPE1', 'Bänd')])
    const n = frames.length
    const head = Buffer.from(['I'.charCodeAt(0), 'D'.charCodeAt(0), '3'.charCodeAt(0), 4, 0, 0, (n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f])
    const file = path.join(work, 'c.mp3')
    fs.writeFileSync(file, Buffer.concat([head, frames, audio]))
    expect(run(file, 'album=Płyta', 'year=1999')).toBe('written')
    const after = fs.readFileSync(file)
    expect(after[3]).toBe(4)
    expect(after.subarray(after.length - audio.length).equals(audio)).toBe(true)
    const meta = await parseFile(file)
    expect(meta.common.title).toBe('Töne')
    expect(meta.common.artist).toBe('Bänd')
    expect(meta.common.album).toBe('Płyta')
    expect(meta.common.year).toBe(1999)
  })
})
