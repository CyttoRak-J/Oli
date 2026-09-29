/**
 * Internet Archive helpers with no Node or Electron dependencies (pure functions and constants): shared by the
 * desktop main process (services/archive.ts) and the Android/web backend in the renderer.
 */
import type {
  ArchiveFile,
  ArchiveHit,
  ArchiveImage,
  ArchiveItem
} from '@shared/types'

export const ARCHIVE_API = 'https://archive.org'
export const ARCHIVE_USER_AGENT = 'Oli/1.0 (desktop music player; https://archive.org/services/docs/api/)'
export const ARCHIVE_TIMEOUT_MS = 15_000
export const ARCHIVE_ITEM_CACHE_MS = 10 * 60_000
export const ARCHIVE_PAGE_SIZE = 25
export const ARCHIVE_MAX_COVER_BYTES = 8 * 1024 * 1024
/** archive.org format labels of real pictures (thumbnails and spectrograms are other labels). */
const IMAGE_FORMATS = ['JPEG', 'PNG']

/** archive.org item format labels that hold lossless audio, best first. */
const LOSSLESS_FORMATS = ['24bit Flac', 'Flac', 'WAVE', 'AIFF', 'Apple Lossless Audio']
/** Lossy formats worth listing (the rest of an item's files are images, text, etc.). */
const LOSSY_FORMATS = ['VBR MP3', '128Kbps MP3', '64Kbps MP3', 'MP3', 'Ogg Vorbis', 'Opus', 'M4A']

const LABELS: Record<string, string> = {
  '24bit Flac': '24-bit FLAC',
  Flac: 'FLAC',
  WAVE: 'WAV',
  AIFF: 'AIFF',
  'Apple Lossless Audio': 'ALAC',
  'VBR MP3': 'MP3 (VBR)',
  '128Kbps MP3': 'MP3 128k',
  '64Kbps MP3': 'MP3 64k',
  MP3: 'MP3',
  'Ogg Vorbis': 'Ogg Vorbis',
  Opus: 'Opus',
  M4A: 'AAC'
}

/** archive.org identifiers are letters, digits, dot, dash and underscore. */
export function isValidIdentifier(id: unknown): id is string {
  return typeof id === 'string' && id.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)
}

export function isLosslessFormat(format: string): boolean {
  return LOSSLESS_FORMATS.includes(format)
}

/** Sort key: lossless first (best format first), then lossy. Unknown formats are dropped. */
export function formatRank(format: string): number {
  const i = LOSSLESS_FORMATS.indexOf(format)
  if (i >= 0) return i
  const j = LOSSY_FORMATS.indexOf(format)
  return j >= 0 ? LOSSLESS_FORMATS.length + j : -1
}

/** Escape user text for archive.org's Lucene query (strip syntax characters). */
export function cleanQuery(text: string): string {
  return text.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, ' ').replace(/\s+/g, ' ').trim()
}

export function buildSearchUrl(text: string, page: number, losslessOnly: boolean): string | null {
  const q = cleanQuery(text)
  if (!q) return null
  let query = `(${q}) AND mediatype:audio`
  if (losslessOnly) {
    query += ` AND format:(${LOSSLESS_FORMATS.map((f) => (f.includes(' ') ? `"${f}"` : f)).join(' OR ')})`
  }
  const params = new URLSearchParams()
  params.set('q', query)
  for (const f of ['identifier', 'title', 'creator', 'year', 'downloads', 'licenseurl']) {
    params.append('fl[]', f)
  }
  params.set('rows', String(ARCHIVE_PAGE_SIZE))
  params.set('page', String(Math.max(1, Math.floor(page) || 1)))
  params.set('output', 'json')
  params.append('sort[]', 'downloads desc')
  return `${ARCHIVE_API}/advancedsearch.php?${params.toString()}`
}

/** Direct download URL for a file of an item (each path segment encoded). */
export function buildDownloadUrl(identifier: string, fileName: string): string {
  return `${ARCHIVE_API}/download/${encodeURIComponent(identifier)}/${fileName
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`
}

function firstString(v: unknown): string | null {
  if (Array.isArray(v)) v = v[0]
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t : null
}

function joinStrings(v: unknown): string | null {
  if (Array.isArray(v)) {
    const parts = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    if (parts.length === 0) return null
    return parts.length > 3 ? `${parts.slice(0, 3).join(', ')} and others` : parts.join(', ')
  }
  return firstString(v)
}

function parseNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseFloat(v) : NaN
  return Number.isFinite(n) ? n : null
}

/** archive.org "length" is either seconds ("10406.5") or "m:ss". */
export function parseLength(v: unknown): number | null {
  if (typeof v === 'string' && v.includes(':')) {
    const parts = v.split(':').map((p) => Number.parseFloat(p))
    if (parts.some((p) => !Number.isFinite(p))) return null
    return parts.reduce((acc, p) => acc * 60 + p, 0)
  }
  return parseNumber(v)
}

export function parseHits(body: unknown): { hits: ArchiveHit[]; total: number } {
  const resp = (body as { response?: { numFound?: number; docs?: Array<Record<string, unknown>> } })
    ?.response
  const docs = Array.isArray(resp?.docs) ? resp.docs : []
  const hits: ArchiveHit[] = []
  for (const d of docs) {
    const identifier = d.identifier
    if (!isValidIdentifier(identifier)) continue
    hits.push({
      identifier,
      title: firstString(d.title) ?? identifier,
      creator: joinStrings(d.creator),
      year: parseNumber(d.year),
      downloads: parseNumber(d.downloads) ?? 0,
      licenseUrl: firstString(d.licenseurl)
    })
  }
  return { hits, total: Number(resp?.numFound) || hits.length }
}

export function parseItem(identifier: string, body: unknown): ArchiveItem {
  const b = body as {
    metadata?: Record<string, unknown>
    files?: Array<Record<string, unknown>>
  }
  const meta = b?.metadata ?? {}
  const files: ArchiveFile[] = []
  for (const f of Array.isArray(b?.files) ? b.files : []) {
    const name = typeof f.name === 'string' ? f.name : ''
    const format = typeof f.format === 'string' ? f.format : ''
    if (!name || formatRank(format) < 0) continue
    files.push({
      name,
      format,
      label: LABELS[format] ?? format,
      lossless: isLosslessFormat(format),
      size: parseNumber(f.size) ?? 0,
      durationSec: parseLength(f.length),
      track: firstString(f.track),
      title: firstString(f.title),
      artist: firstString(f.artist) ?? firstString(f.creator),
      album: firstString(f.album),
      genre: firstString(f.genre),
      md5: firstString(f.md5)
    })
  }
  const images: ArchiveImage[] = []
  for (const f of Array.isArray(b?.files) ? b.files : []) {
    const name = typeof f.name === 'string' ? f.name : ''
    const format = typeof f.format === 'string' ? f.format : ''
    const size = parseNumber(f.size) ?? 0
    if (name && IMAGE_FORMATS.includes(format) && size > 0 && size <= ARCHIVE_MAX_COVER_BYTES) images.push({ name, size })
  }
  files.sort(
    (a, z) =>
      formatRank(a.format) - formatRank(z.format) ||
      (Number.parseInt(a.track ?? '', 10) || 0) - (Number.parseInt(z.track ?? '', 10) || 0) ||
      a.name.localeCompare(z.name, undefined, { numeric: true })
  )
  return {
    identifier,
    title: firstString(meta.title) ?? identifier,
    creator: joinStrings(meta.creator),
    date: firstString(meta.date) ?? firstString(meta.year),
    licenseUrl: firstString(meta.licenseurl),
    files,
    images
  }
}

function stemOf(name: string): string {
  const base = name.split('/').pop() ?? name
  const dot = base.lastIndexOf('.')
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase()
}

/**
 * Best cover for one audio file: a picture named like the track, then one
 * named like cover art (cover/front/folder/artwork/album), then the largest
 * picture of the item. null when the item has no usable picture.
 */
export function pickCover(images: ArchiveImage[], audioName: string): ArchiveImage | null {
  if (images.length === 0) return null
  const stem = stemOf(audioName)
  return (
    images.find((i) => stemOf(i.name) === stem) ??
    images.find((i) => /(^|[^a-z])(cover|front|folder|artwork|album)([^a-z]|$)/i.test(stemOf(i.name))) ??
    [...images].sort((a, z) => z.size - a.size)[0]
  )
}

