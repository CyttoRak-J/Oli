import { protocol } from 'electron'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { Readable } from 'node:stream'
import { getLogger } from './services/logger'
import type { ArtworkService } from './services/artwork'

export const ART_SCHEME = 'cyttos-art'

/** Scheme used to stream local audio files into the renderer (avoids WebSecurity file:// restrictions). */
export const LOCAL_SCHEME = 'cyttos-local'

/** Scheme used to serve bundled static assets (e.g. hls.js) to player pages. */
export const VENDOR_SCHEME = 'cyttos-vendor'

/** Must be called before app 'ready'. */
export function declareCustomSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ART_SCHEME,
      privileges: { secure: true, stream: true, supportFetchAPI: true }
    },
    {
      scheme: LOCAL_SCHEME,
      privileges: { secure: true, stream: true, supportFetchAPI: true }
    },
    {
      scheme: VENDOR_SCHEME,
      privileges: { secure: true, stream: true, supportFetchAPI: true, standard: true }
    }
  ])
}

/** Serves bundled script assets (hls.js) used by the internal video player. */
export function registerVendorProtocol(): void {
  protocol.handle(VENDOR_SCHEME, (request) => {
    try {
      const url = new URL(request.url)
      const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      if (name !== 'hls.min.js') return new Response('Not found', { status: 404 })
      const file = require.resolve('hls.js/dist/hls.min.js')
      const stream = Readable.toWeb(fs.createReadStream(file))
      const size = fs.statSync(file).size
      return new Response(stream as ReadableStream, {
        status: 200,
        headers: {
          'Content-Type': 'application/javascript',
          'Content-Length': String(size)
        }
      })
    } catch (err) {
      getLogger().debug('cyttos-vendor handler error', err)
      return new Response('Bad request', { status: 400 })
    }
  })
}

export function registerArtworkProtocol(artwork: ArtworkService): void {
  protocol.handle(ART_SCHEME, (request) => {
    try {
      const url = new URL(request.url)
      const key = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      if (!key) return new Response('Not found', { status: 404 })
      let file = artwork.get(key)
      // No own artwork: reuse the cover of a sibling in the same merged album.
      if (!file && key.startsWith('song:')) {
        const source = artwork.albumCoverSource(key)
        if (source) file = artwork.get(source)
      }
      if (!file) return new Response('Not found', { status: 404 })
      const mime = sniffImageMime(file)
      const size = fs.statSync(file).size
      const stream = Readable.toWeb(fs.createReadStream(file))
      return new Response(stream as ReadableStream, {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(size)
        }
      })
    } catch (err) {
      getLogger().debug('cyttos-art handler error', err)
      return new Response('Bad request', { status: 400 })
    }
  })
}

/** Detect image type from magic bytes; cache files are stored as opaque `.img`. */
function sniffImageMime(file: string): string {
  try {
    const fd = fs.openSync(file, 'r')
    const head = Buffer.alloc(16)
    try {
      fs.readSync(fd, head, 0, 16, 0)
    } finally {
      fs.closeSync(fd)
    }
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47)
      return 'image/png'
    if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38)
      return 'image/gif'
    if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46)
      return 'image/webp'
    if (head[0] === 0x42 && head[1] === 0x4d) return 'image/bmp'
    return 'image/jpeg'
  } catch {
    return 'image/jpeg'
  }
}

const AUDIO_MIME: Record<string, string> = {
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mp4': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wma': 'audio/x-ms-wma',
  '.webm': 'audio/webm',
  '.mp2': 'audio/mpeg',
  '.ape': 'audio/x-ape',
  '.wv': 'audio/x-wavpack',
  '.mka': 'audio/x-matroska'
}

function audioMime(file: string): string {
  return AUDIO_MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/** Serves local files (music) over cyttos-local://file/<encoded absolute path>, with Range support. */
export function registerLocalProtocol(): void {
  protocol.handle(LOCAL_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const file = decodeURIComponent(url.pathname.replace(/^\//, ''))
      if (!file || !path.isAbsolute(file)) return new Response('Bad request', { status: 400 })
      const stat = await fsp.stat(file)
      if (!stat.isFile()) return new Response('Not found', { status: 404 })
      const total = stat.size
      const range = request.headers.get('range')

      if (range && /^bytes=\d*-\d*$/.test(range.trim())) {
        const [startRaw, endRaw] = range.trim().slice(6).split('-')
        let start = startRaw === '' ? 0 : parseInt(startRaw, 10)
        let end = endRaw === '' ? total - 1 : parseInt(endRaw, 10)
        if (startRaw === '' && endRaw !== '') {
          start = Math.max(0, total - parseInt(endRaw, 10))
          end = total - 1
        }
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
          return new Response('Range Not Satisfiable', {
            status: 416,
            headers: { 'Content-Range': `bytes */${total}` }
          })
        }
        end = Math.min(end, total - 1)
        const stream = Readable.toWeb(fs.createReadStream(file, { start, end }))
        return new Response(stream as ReadableStream, {
          status: 206,
          headers: {
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(end - start + 1),
            'Content-Type': audioMime(file)
          }
        })
      }

      const stream = Readable.toWeb(fs.createReadStream(file))
      return new Response(stream as ReadableStream, {
        status: 200,
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Length': String(total),
          'Content-Type': audioMime(file)
        }
      })
    } catch (err) {
      getLogger().debug('cyttos-local handler error', err)
      return new Response('Bad request', { status: 400 })
    }
  })
}