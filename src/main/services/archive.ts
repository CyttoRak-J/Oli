import { getLogger } from './logger'
import type {
  ArchiveFile,
  ArchiveHit,
  ArchiveImage,
  ArchiveItem,
  ArchiveSearchResult
} from '@shared/types'

const API = 'https://archive.org'
const USER_AGENT = 'Oli/1.0 (desktop music player; https://archive.org/services/docs/api/)'
const TIMEOUT_MS = 15_000
const ITEM_CACHE_MS = 10 * 60_000
const PAGE_SIZE = 25
const MAX_COVER_BYTES = 8 * 1024 * 1024
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
  params.set('rows', String(PAGE_SIZE))
  params.set('page', String(Math.max(1, Math.floor(page) || 1)))
  params.set('output', 'json')
  params.append('sort[]', 'downloads desc')
  return `${API}/advancedsearch.php?${params.toString()}`
}

/** Direct download URL for a file of an item (each path segment encoded). */
export function buildDownloadUrl(identifier: string, fileName: string): string {
  return `${API}/download/${encodeURIComponent(identifier)}/${fileName
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
    if (name && IMAGE_FORMATS.includes(format) && size > 0 && size <= MAX_COVER_BYTES) images.push({ name, size })
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

async function getJson(url: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: controller.signal
    })
    if (!res.ok) throw new Error(`archive.org answered HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function describe(err: unknown): string {
  const e = err as Error
  if (e?.name === 'AbortError') return 'archive.org took too long to answer'
  return e?.message || 'Could not reach archive.org'
}

/**
 * Internet Archive (archive.org) search and file listing. Public, keyless
 * endpoints only; files download through the normal download queue.
 */
export class ArchiveService {
  private items = new Map<string, { at: number; item: ArchiveItem }>()
  private covers = new Map<string, Buffer>()

  async search(text: string, page = 1, losslessOnly = true): Promise<ArchiveSearchResult> {
    const url = buildSearchUrl(text, page, losslessOnly)
    if (!url) return { hits: [], total: 0, page: 1 }
    try {
      const { hits, total } = parseHits(await getJson(url))
      return { hits, total, page }
    } catch (err) {
      getLogger().warn('archive search failed', err)
      return { hits: [], total: 0, page, error: describe(err) }
    }
  }

  async getItem(identifier: string): Promise<ArchiveItem> {
    if (!isValidIdentifier(identifier)) {
      return { identifier: String(identifier), title: '', creator: null, date: null, licenseUrl: null, files: [], images: [], error: 'Invalid item' }
    }
    const cached = this.items.get(identifier)
    if (cached && Date.now() - cached.at < ITEM_CACHE_MS) return cached.item
    try {
      const body = await getJson(`${API}/metadata/${encodeURIComponent(identifier)}`)
      const item = parseItem(identifier, body)
      this.items.set(identifier, { at: Date.now(), item })
      if (this.items.size > 50) this.items.delete(this.items.keys().next().value as string)
      return item
    } catch (err) {
      getLogger().warn('archive item failed', err)
      return { identifier, title: identifier, creator: null, date: null, licenseUrl: null, files: [], images: [], error: describe(err) }
    }
  }

  /** Cover picture for a file of an item, or null (missing, too big, or the request failed). */
  async getCover(item: ArchiveItem, audioName: string): Promise<Buffer | null> {
    const pick = pickCover(item.images, audioName)
    if (!pick) return null
    const key = `${item.identifier}/${pick.name}`
    const hit = this.covers.get(key)
    if (hit) return hit
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(buildDownloadUrl(item.identifier, pick.name), {
        headers: { 'User-Agent': USER_AGENT },
        signal: controller.signal
      })
      if (!res.ok) return null
      const data = Buffer.from(await res.arrayBuffer())
      if (data.length === 0 || data.length > MAX_COVER_BYTES) return null
      this.covers.set(key, data)
      if (this.covers.size > 6) this.covers.delete(this.covers.keys().next().value as string)
      return data
    } catch (err) {
      getLogger().debug('archive cover failed', err)
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}
