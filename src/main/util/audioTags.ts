import * as fs from 'node:fs'
import NodeID3 from 'node-id3'

/** Tags written into downloaded files. Only fields the file does not have yet are filled. */
export interface FileTags {
  title?: string | null
  artist?: string | null
  album?: string | null
  /** Track number, e.g. "3" or "3/12". */
  track?: string | null
  /** Year or full date. */
  date?: string | null
  genre?: string | null
  /** Front cover (JPEG or PNG bytes), embedded only when the file has none. */
  cover?: Buffer | null
}

const FLAC_MAGIC = Buffer.from('fLaC')
const TYPE_STREAMINFO = 0
const TYPE_PADDING = 1
const TYPE_VORBIS_COMMENT = 4
const TYPE_PICTURE = 6

interface FlacBlock {
  type: number
  data: Buffer
}

/** Vorbis comment field name -> FileTags key. */
const FIELDS: Array<[string, Exclude<keyof FileTags, 'cover'>]> = [
  ['TITLE', 'title'],
  ['ARTIST', 'artist'],
  ['ALBUM', 'album'],
  ['TRACKNUMBER', 'track'],
  ['DATE', 'date'],
  ['GENRE', 'genre']
]

function clean(v: string | null | undefined): string | null {
  const t = v?.replace(/\p{C}/gu, ' ').trim()
  return t ? t : null
}

/** Parse a Vorbis comment block body: vendor string plus KEY=value entries. */
export function parseVorbisComment(data: Buffer): { vendor: string; comments: string[] } {
  let pos = 0
  const vendorLen = data.readUInt32LE(pos)
  pos += 4
  const vendor = data.subarray(pos, pos + vendorLen).toString('utf8')
  pos += vendorLen
  const count = data.readUInt32LE(pos)
  pos += 4
  const comments: string[] = []
  for (let i = 0; i < count && pos + 4 <= data.length; i++) {
    const len = data.readUInt32LE(pos)
    pos += 4
    if (pos + len > data.length) break
    comments.push(data.subarray(pos, pos + len).toString('utf8'))
    pos += len
  }
  return { vendor, comments }
}

export function buildVorbisComment(vendor: string, comments: string[]): Buffer {
  const parts: Buffer[] = []
  const v = Buffer.from(vendor, 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(v.length)
  parts.push(head, v)
  const count = Buffer.alloc(4)
  count.writeUInt32LE(comments.length)
  parts.push(count)
  for (const c of comments) {
    const b = Buffer.from(c, 'utf8')
    const len = Buffer.alloc(4)
    len.writeUInt32LE(b.length)
    parts.push(len, b)
  }
  return Buffer.concat(parts)
}

/** Add the wanted fields that the comment list does not have (or has empty). */
export function mergeComments(existing: string[], tags: FileTags): { comments: string[]; added: string[] } {
  const have = new Set<string>()
  for (const c of existing) {
    const eq = c.indexOf('=')
    if (eq > 0 && c.slice(eq + 1).trim()) have.add(c.slice(0, eq).toUpperCase())
  }
  const comments = [...existing]
  const added: string[] = []
  for (const [field, key] of FIELDS) {
    const value = clean(tags[key])
    if (!value || have.has(field)) continue
    // An empty "TITLE=" entry would shadow ours in some readers: drop it.
    for (let i = comments.length - 1; i >= 0; i--) {
      if (comments[i].toUpperCase().startsWith(`${field}=`)) comments.splice(i, 1)
    }
    comments.push(`${field}=${value}`)
    added.push(field)
  }
  return { comments, added }
}

/** Mime type and size from the image bytes themselves (JPEG or PNG only). */
export function sniffImage(data: Buffer): { mime: string; width: number; height: number; depth: number } | null {
  if (data.length > 24 && data.readUInt32BE(0) === 0x89504e47 && data.toString('ascii', 12, 16) === 'IHDR') {
    const colorType = data[25]
    const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 4 ? 2 : 1
    return { mime: 'image/png', width: data.readUInt32BE(16), height: data.readUInt32BE(20), depth: data[24] * channels }
  }
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let pos = 2
    while (pos + 9 < data.length) {
      if (data[pos] !== 0xff) {
        pos++
        continue
      }
      const marker = data[pos + 1]
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          mime: 'image/jpeg',
          height: data.readUInt16BE(pos + 5),
          width: data.readUInt16BE(pos + 7),
          depth: data[pos + 4] * data[pos + 9]
        }
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) pos += 2
      else pos += 2 + data.readUInt16BE(pos + 2)
    }
    return { mime: 'image/jpeg', width: 0, height: 0, depth: 0 }
  }
  return null
}

/** A FLAC PICTURE block body (picture type 3 = front cover). */
export function buildPictureBlock(data: Buffer): Buffer | null {
  const info = sniffImage(data)
  if (!info) return null
  const mime = Buffer.from(info.mime, 'ascii')
  const head = Buffer.alloc(8 + mime.length + 4 + 20)
  let p = 0
  head.writeUInt32BE(3, p)
  p += 4
  head.writeUInt32BE(mime.length, p)
  p += 4
  mime.copy(head, p)
  p += mime.length
  head.writeUInt32BE(0, p) // empty description
  p += 4
  head.writeUInt32BE(info.width, p)
  head.writeUInt32BE(info.height, p + 4)
  head.writeUInt32BE(info.depth, p + 8)
  head.writeUInt32BE(0, p + 12) // not indexed
  head.writeUInt32BE(data.length, p + 16)
  return Buffer.concat([head, data])
}

function serializeBlocks(blocks: FlacBlock[]): Buffer {
  const parts: Buffer[] = []
  blocks.forEach((b, i) => {
    const h = Buffer.alloc(4)
    h[0] = (i === blocks.length - 1 ? 0x80 : 0) | b.type
    h.writeUIntBE(b.data.length, 1, 3)
    parts.push(h, b.data)
  })
  return Buffer.concat(parts)
}

/**
 * Fill missing tags of a FLAC file. Returns the fields written ([] when the
 * file already had everything, or is not a plain FLAC file). Uses the file's
 * padding when the new tags fit (no rewrite of the audio); otherwise rewrites
 * through a temp file that replaces the original only when complete.
 */
export function writeFlacTags(file: string, tags: FileTags): string[] {
  const fd = fs.openSync(file, 'r')
  const blocks: FlacBlock[] = []
  let audioStart = 4
  try {
    const magic = Buffer.alloc(4)
    if (fs.readSync(fd, magic, 0, 4, 0) !== 4 || !magic.equals(FLAC_MAGIC)) return []
    let pos = 4
    for (;;) {
      const h = Buffer.alloc(4)
      if (fs.readSync(fd, h, 0, 4, pos) !== 4) return []
      const last = (h[0] & 0x80) !== 0
      const type = h[0] & 0x7f
      const len = h.readUIntBE(1, 3)
      const data = Buffer.alloc(len)
      if (len > 0 && fs.readSync(fd, data, 0, len, pos + 4) !== len) return []
      blocks.push({ type, data })
      pos += 4 + len
      if (last) break
    }
    audioStart = pos
  } finally {
    fs.closeSync(fd)
  }
  if (blocks[0]?.type !== TYPE_STREAMINFO) return []

  const vcIndex = blocks.findIndex((b) => b.type === TYPE_VORBIS_COMMENT)
  const parsed =
    vcIndex >= 0 ? parseVorbisComment(blocks[vcIndex].data) : { vendor: 'Oli', comments: [] as string[] }
  const { comments, added } = mergeComments(parsed.comments, tags)
  // Block lengths are 24-bit: a picture that does not fit is skipped.
  const picture =
    tags.cover && !blocks.some((b) => b.type === TYPE_PICTURE) ? buildPictureBlock(tags.cover) : null
  const pictureBlock = picture && picture.length < 0xffffff ? { type: TYPE_PICTURE, data: picture } : null
  if (pictureBlock) added.push('COVER')
  if (added.length === 0) return []
  const vc: FlacBlock = { type: TYPE_VORBIS_COMMENT, data: buildVorbisComment(parsed.vendor, comments) }
  if (vcIndex >= 0) blocks[vcIndex] = vc
  else blocks.splice(1, 0, vc)
  if (pictureBlock) blocks.splice(blocks.findIndex((b) => b.type === TYPE_VORBIS_COMMENT) + 1, 0, pictureBlock)

  const oldRegion = audioStart - 4
  // Fold every padding block into one so the size arithmetic below is simple.
  const withoutPadding = blocks.filter((b) => b.type !== TYPE_PADDING)
  const fixed = serializeBlocks(withoutPadding).length
  const slack = oldRegion - fixed
  // In place: the remainder must be able to hold a padding block (4-byte header) or be zero.
  if (slack === 0 || slack >= 4) {
    const layout =
      slack === 0
        ? withoutPadding
        : [...withoutPadding, { type: TYPE_PADDING, data: Buffer.alloc(slack - 4) }]
    const bytes = serializeBlocks(layout)
    if (bytes.length === oldRegion) {
      const wfd = fs.openSync(file, 'r+')
      try {
        fs.writeSync(wfd, bytes, 0, bytes.length, 4)
      } finally {
        fs.closeSync(wfd)
      }
      return added
    }
  }

  // Not enough room: rewrite with 2 KB of padding, audio copied unchanged.
  const layout = [...withoutPadding, { type: TYPE_PADDING, data: Buffer.alloc(2048) }]
  const header = Buffer.concat([FLAC_MAGIC, serializeBlocks(layout)])
  const tmp = `${file}.tagging`
  const rfd = fs.openSync(file, 'r')
  const ofd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(ofd, header)
    const buf = Buffer.alloc(1 << 20)
    let at = audioStart
    for (;;) {
      const n = fs.readSync(rfd, buf, 0, buf.length, at)
      if (n <= 0) break
      fs.writeSync(ofd, buf, 0, n)
      at += n
    }
  } catch (err) {
    fs.closeSync(rfd)
    fs.closeSync(ofd)
    fs.rmSync(tmp, { force: true })
    throw err
  }
  fs.closeSync(rfd)
  fs.closeSync(ofd)
  fs.renameSync(tmp, file)
  return added
}

/** Fill missing ID3 fields of an MP3 file. Returns the fields written. */
export function writeMp3Tags(file: string, tags: FileTags): string[] {
  const existing = NodeID3.read(file)
  const update: Record<string, unknown> = {}
  const added: string[] = []
  const set = (field: string, key: string, value: string | null | undefined, have: unknown): void => {
    const v = clean(value)
    if (!v || (typeof have === 'string' && have.trim())) return
    update[key] = v
    added.push(field)
  }
  set('TITLE', 'title', tags.title, existing.title)
  set('ARTIST', 'artist', tags.artist, existing.artist)
  set('ALBUM', 'album', tags.album, existing.album)
  set('TRACKNUMBER', 'trackNumber', tags.track, existing.trackNumber)
  set('DATE', 'year', tags.date?.slice(0, 4), existing.year)
  set('GENRE', 'genre', tags.genre, existing.genre)
  const image = tags.cover ? sniffImage(tags.cover) : null
  if (image && tags.cover && !existing.image) {
    update.image = {
      mime: image.mime,
      type: { id: 3, name: 'front cover' },
      description: '',
      imageBuffer: tags.cover
    }
    added.push('COVER')
  }
  if (added.length === 0) return []
  if (NodeID3.update(update as NodeID3.Tags, file) !== true) throw new Error('could not write ID3 tags')
  return added
}

/** Fill missing tags of a downloaded file by extension. Unsupported types are left alone. */
export function writeAudioTags(file: string, tags: FileTags): string[] {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'flac') return writeFlacTags(file, tags)
  if (ext === 'mp3') return writeMp3Tags(file, tags)
  return []
}
