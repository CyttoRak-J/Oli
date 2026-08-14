import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { parseBuffer, parseFile, type IAudioMetadata } from 'music-metadata'
import { getLogger } from './logger'
import { AUDIO_EXTENSIONS, FORMAT_LABELS } from '@shared/constants'

export interface ExtractedArtwork {
  mimeType: string
  data: Buffer
}

export interface ParsedTrack {
  title: string
  artist: string
  albumArtist: string
  album: string
  genre: string | null
  composer: string | null
  year: number | null
  releaseDate: string | null
  trackNo: number | null
  discNo: number | null
  isrc: string | null
  rating: number | null
  duration: number
  bitrate: number | null
  sampleRate: number | null
  bitDepth: number | null
  channels: number | null
  codec: string | null
  format: string | null
  fileSize: number | null
  replayGain: number | null
  replayGainAlbum: number | null
  lyrics: string | null
  artwork: ExtractedArtwork | null
}

export const AUDIO_EXT_SET = new Set<string>(AUDIO_EXTENSIONS.map((e) => e.toLowerCase()))

export function isAudioFile(filePath: string): boolean {
  return AUDIO_EXT_SET.has(path.extname(filePath).toLowerCase())
}

function firstString(value: string | string[] | undefined | null): string | null {
  if (!value) return null
  if (typeof value === 'string') return value.trim() || null
  for (const item of value) {
    if (item && item.trim()) return item.trim()
  }
  return null
}

function cleanName(value: string | null, fallback: string): string {
  if (value && value.trim().length > 0) return value.trim()
  return fallback
}

function baseName(filePath: string): string {
  const base = path.basename(filePath).replace(/\.[^/.]+$/, '')
  return base && base.trim().length > 0 ? base.trim() : 'Unknown Title'
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function extractLyrics(lyrics: unknown): string | null {
  if (!lyrics) return null
  if (typeof lyrics === 'string') return lyrics
  if (Array.isArray(lyrics)) {
    for (const entry of lyrics) {
      if (entry) {
        if (typeof entry === 'string' && entry.trim()) return entry.trim()
        const text =
          (entry as { text?: string }).text ?? (entry as { lyrics?: string }).lyrics
        if (text && text.toString().trim()) return text.toString().trim()
      }
    }
  }
  return null
}

function guessImageMime(data: Buffer): string {
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg'
  }
  if (data.length > 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return 'image/png'
  }
  if (data.length > 12 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) {
    return 'image/webp'
  }
  return 'image/jpeg'
}

function estimateDuration(bitrate: number | undefined, size: number): number {
  if (bitrate && bitrate > 0) {
    const duration = (size * 8) / bitrate
    if (Number.isFinite(duration) && duration > 0) return duration
  }
  return 0
}

function extractReplayGain(
  format: IAudioMetadata['format']
): { track: number | null; album: number | null } {
  const toDb = (v: number | undefined): number | null => {
    if (v == null || !Number.isFinite(v)) return null
    return Math.round(v * 100) / 100
  }
  return { track: toDb(format.trackGain), album: toDb(format.albumGain) }
}

export interface TrackFileSource {
  filePath: string
  buffer: Buffer
  mtimeMs: number
  size: number
}

/**
 * Reads a file into memory (stat checks before read) returning null for
 * missing files, directories or unreadable files.
 */
export async function readFileSource(filePath: string): Promise<TrackFileSource | null> {
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile()) return null
    const buffer = await fs.readFile(filePath)
    return { filePath, buffer, mtimeMs: stat.mtimeMs, size: stat.size }
  } catch (err) {
    getLogger().warn(`Cannot read file: ${filePath}`, err)
    return null
  }
}

/**
 * Parses an in-memory file buffer. Returns null when the file is corrupt or
 * the format is unrecognised. Never throws (callers rely on that).
 */
export async function parseTrackBag(parsed: TrackFileSource): Promise<ParsedTrack | null> {
  const { filePath, buffer, size } = parsed
  const log = getLogger()
  let meta: IAudioMetadata
  try {
    meta = await parseBuffer(buffer, { path: filePath, size })
  } catch (err) {
    log.debug(`Metadata parse failed for ${filePath}: ${String(err)}`)
    return null
  }
  return buildParsedTrack(meta, filePath, size)
}

/**
 * Streams a file from disk for metadata extraction instead of buffering the
 * whole file in memory (important for large FLAC/WAV files). Never throws.
 */
export async function parseTrackFile(filePath: string): Promise<ParsedTrack | null> {
  const log = getLogger()
  let meta: IAudioMetadata
  let size: number
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile()) return null
    size = stat.size
    meta = await parseFile(filePath, { duration: true })
  } catch (err) {
    log.debug(`Metadata parse failed for ${filePath}: ${String(err)}`)
    return null
  }
  return buildParsedTrack(meta, filePath, size)
}

function buildParsedTrack(meta: IAudioMetadata, filePath: string, size: number): ParsedTrack | null {
  const common = meta.common
  const format = meta.format
  const artistName = firstString(common.artist) ?? (common.artists?.length ? common.artists.join(' / ') : null)
  const artist = cleanName(artistName, 'Unknown Artist')
  const albumArtist = firstString(common.albumartist) ?? firstString(common.albumartists) ?? ''
  const rg = extractReplayGain(format)

  const ext = path.extname(filePath).toUpperCase().replace('.', '')
  // MP4/M4A files can accumulate multiple `covr` boxes (one per attached
  // picture) when a cover is re-embedded without replacing old ones; the last
  // box is the most recently embedded art. Other formats keep the first
  // picture (APIC front cover in MP3, etc.).
  const pictures = common.picture ?? []
  const pic =
    pictures.length > 0
      ? ['MP4', 'M4A', 'MOV', 'M4B'].includes(ext)
        ? pictures[pictures.length - 1]
        : pictures[0]
      : null
  let artwork: ExtractedArtwork | null = null
  if (pic && pic.data && pic.data.length > 0) {
    artwork = {
      mimeType: pic.format || guessImageMime(Buffer.from(pic.data)),
      data: Buffer.from(pic.data)
    }
  }

  const duration =
    format.duration && format.duration > 0 && Number.isFinite(format.duration)
      ? format.duration
      : estimateDuration(format.bitrate, size)
  const title = cleanName(common.title ?? null, baseName(filePath))

  return {
    title,
    artist,
    albumArtist: cleanName(albumArtist, ''),
    album: cleanName(firstString(common.album), 'Unknown Album'),
    genre: firstString(common.genre),
    composer: firstString(common.composer),
    year: numberOrNull(common.year),
    releaseDate: common.date ? String(common.date) : null,
    trackNo: typeof common.track?.no === 'number' ? common.track.no : null,
    discNo: typeof common.disk?.no === 'number' ? common.disk.no : null,
    isrc: common.isrc ? String(common.isrc) : null,
    rating: numberOrNull(common.rating),
    duration,
    bitrate: format.bitrate || null,
    sampleRate: format.sampleRate || null,
    bitDepth: format.bitsPerSample ?? null,
    channels: format.numberOfChannels || null,
    codec: format.codec || null,
    format: FORMAT_LABELS[ext.toLowerCase()] ?? (ext || 'unknown').toLowerCase(),
    fileSize: size,
    replayGain: rg.track,
    replayGainAlbum: rg.album,
    lyrics: extractLyrics(common.lyrics),
    artwork
  }
}

/** Convenience wrapper used by one-off IPC calls (single file parse). */
export async function readTrackFromFile(filePath: string): Promise<ParsedTrack | null> {
  const source = await readFileSource(filePath)
  if (!source) return null

  return parseTrackBag(source)
}

export function trackFormatLabel(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase()
  return FORMAT_LABELS[ext] ?? (ext || 'unknown')
}