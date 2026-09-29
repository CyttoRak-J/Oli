import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseFile } from 'music-metadata'
import NodeID3 from 'node-id3'
import {
  buildVorbisComment,
  sniffImage,
  mergeComments,
  parseVorbisComment,
  writeAudioTags,
  writeFlacTags
} from '../src/main/util/audioTags'

/** A tiny but valid FLAC: STREAMINFO (+ optional blocks) followed by junk "frames". */
function makeFlac(extra: Array<{ type: number; data: Buffer }> = [], frames = Buffer.alloc(5000, 0xa5)): Buffer {
  const info = Buffer.alloc(34)
  info.writeUInt16BE(4096, 0)
  info.writeUInt16BE(4096, 2)
  // 44100 Hz (20 bits) | 1 channel-1 (3 bits) | 16 bits-1 (5 bits) | total samples (36 bits)
  info.writeUIntBE(((44100 * 2 ** 12 + 1 * 2 ** 9 + 15 * 2 ** 4) >>> 0) * 1, 10, 4)
  const blocks = [{ type: 0, data: info }, ...extra]
  const parts: Buffer[] = [Buffer.from('fLaC')]
  blocks.forEach((b, i) => {
    const h = Buffer.alloc(4)
    h[0] = (i === blocks.length - 1 ? 0x80 : 0) | b.type
    h.writeUIntBE(b.data.length, 1, 3)
    parts.push(h, b.data)
  })
  parts.push(frames)
  return Buffer.concat(parts)
}

describe('vorbis comments', () => {
  it('round-trips and merges only missing fields', () => {
    const buf = buildVorbisComment('vend', ['TITLE=Keep', 'ARTIST=', 'album=Low'])
    const { vendor, comments } = parseVorbisComment(buf)
    expect(vendor).toBe('vend')
    const m = mergeComments(comments, { title: 'New', artist: 'A', album: 'B', track: '3', genre: '  ' })
    expect(m.added.sort()).toEqual(['ARTIST', 'TRACKNUMBER'])
    expect(m.comments).toContain('TITLE=Keep')
    expect(m.comments).toContain('album=Low')
    expect(m.comments).toContain('ARTIST=A')
    expect(m.comments.some((c) => c === 'ARTIST=')).toBe(false)
  })
})

describe('FLAC tag writing', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oli-tags-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const tags = { title: 'Song', artist: 'Band', album: 'Record', track: '2', date: '1999' }
  const frames = Buffer.alloc(7000, 0x5a)

  function audioTail(file: string): Buffer {
    const b = fs.readFileSync(file)
    return b.subarray(b.length - frames.length)
  }

  it('writes into padding without touching the audio or the file size', async () => {
    const f = path.join(dir, 'pad.flac')
    fs.writeFileSync(f, makeFlac([{ type: 1, data: Buffer.alloc(4096) }], frames))
    const size = fs.statSync(f).size
    expect(writeFlacTags(f, tags).sort()).toEqual(['ALBUM', 'ARTIST', 'DATE', 'TITLE', 'TRACKNUMBER'])
    expect(fs.statSync(f).size).toBe(size)
    expect(audioTail(f).equals(frames)).toBe(true)
    const md = await parseFile(f)
    expect(md.common).toMatchObject({ title: 'Song', artist: 'Band', album: 'Record', year: 1999 })
    expect(md.common.track.no).toBe(2)
  })

  it('rewrites the file when there is no room, keeping audio and existing tags', async () => {
    const f = path.join(dir, 'tight.flac')
    const vc = buildVorbisComment('old', ['GENRE=Jazz', 'TITLE=Original'])
    fs.writeFileSync(f, makeFlac([{ type: 4, data: vc }], frames))
    writeFlacTags(f, tags)
    expect(audioTail(f).equals(frames)).toBe(true)
    expect(fs.existsSync(f + '.tagging')).toBe(false)
    const md = await parseFile(f)
    expect(md.common.title).toBe('Original')
    expect(md.common.genre).toEqual(['Jazz'])
    expect(md.common.artist).toBe('Band')
    // second run: nothing left to add, file untouched
    const before = fs.readFileSync(f)
    expect(writeFlacTags(f, tags)).toEqual([])
    expect(fs.readFileSync(f).equals(before)).toBe(true)
  })

  it('ignores files that are not FLAC and unsupported extensions', () => {
    const f = path.join(dir, 'fake.flac')
    fs.writeFileSync(f, Buffer.from('RIFF....WAVE'))
    expect(writeAudioTags(f, tags)).toEqual([])
    const w = path.join(dir, 'x.wav')
    fs.writeFileSync(w, Buffer.from('RIFF'))
    expect(writeAudioTags(w, tags)).toEqual([])
  })

  it('embeds cover art in FLAC (rewrite and padding paths) and never replaces an existing picture', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )
    expect(sniffImage(png)).toMatchObject({ mime: 'image/png', width: 1, height: 1 })
    expect(sniffImage(Buffer.from('not an image at all'))).toBeNull()

    const tight = path.join(dir, 'tight.flac')
    fs.writeFileSync(tight, makeFlac([], frames))
    expect(writeFlacTags(tight, { ...tags, cover: png })).toContain('COVER')
    expect(audioTail(tight).equals(frames)).toBe(true)
    const md = await parseFile(tight)
    expect(md.common.picture?.[0]).toMatchObject({ format: 'image/png' })
    expect(Buffer.from(md.common.picture![0].data).equals(png)).toBe(true)
    // already has a picture: nothing more to add
    expect(writeFlacTags(tight, { ...tags, cover: png })).toEqual([])

    const roomy = path.join(dir, 'roomy.flac')
    fs.writeFileSync(roomy, makeFlac([{ type: 1, data: Buffer.alloc(4096) }], frames))
    const size = fs.statSync(roomy).size
    writeFlacTags(roomy, { cover: png })
    expect(fs.statSync(roomy).size).toBe(size)
    expect((await parseFile(roomy)).common.picture).toHaveLength(1)

    expect(writeAudioTags(path.join(dir, 'notes.txt'), { cover: png })).toEqual([])
  })

  it('embeds cover art in MP3 only when it has none', () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )
    const f = path.join(dir, 'a.mp3')
    fs.writeFileSync(f, Buffer.alloc(3000, 0))
    expect(writeAudioTags(f, { title: 'T', cover: png }).sort()).toEqual(['COVER', 'TITLE'])
    const img = NodeID3.read(f).image as { imageBuffer: Buffer } | undefined
    expect(img?.imageBuffer.equals(png)).toBe(true)
    expect(writeAudioTags(f, { title: 'Other', cover: png })).toEqual([])
  })
})
