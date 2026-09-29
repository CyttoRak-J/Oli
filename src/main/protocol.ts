import { net, protocol } from 'electron'
import { pathToFileURL } from 'node:url'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { Readable } from 'node:stream'
import { getLogger } from './services/logger'
import { playablePath } from './util/longPath'
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

/**
 * Serves local files (music) over cyttos-local://file/<encoded absolute path>.
 *
 * The bytes come from Chromium's own file loader (net.fetch on a file:// URL
 * with the protocol handlers bypassed), which implements Range requests
 * exactly the way the media pipeline expects. A hand-written Range handler
 * here made seeking fail with "FFmpegDemuxer: data source error" (so a
 * resume after pause or a click on the progress bar broke playback) and
 * made Opus files unplayable.
 */
export function registerLocalProtocol(): void {
  protocol.handle(LOCAL_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const file = decodeURIComponent(url.pathname.replace(/^\//, ''))
      if (!file || !path.isAbsolute(file)) return new Response('Bad request', { status: 400 })
      const stat = await fsp.stat(file)
      if (!stat.isFile()) return new Response('Not found', { status: 404 })
      // Very long paths (> Windows MAX_PATH) are served from a short-path copy.
      const readable = await playablePath(file)
      return await net.fetch(pathToFileURL(readable).toString(), {
        headers: request.headers,
        bypassCustomProtocolHandlers: true
      })
    } catch (err) {
      getLogger().debug('cyttos-local handler error', err)
      return new Response('Not found', { status: 404 })
    }
  })
}
