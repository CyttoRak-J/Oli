import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import { getLogger } from './logger'
import { TRANSCODE_TMP_DIR } from './transcode'
import { LONGPATH_DIR, playablePath } from '../util/longPath'
import type { Database } from './database'

const AUDIO_TYPES: Record<string, string> = {
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
  '.webm': 'audio/webm',
  '.wma': 'audio/x-ms-wma',
  '.mka': 'audio/x-matroska'
}

/** Folders (besides the library) the player may read: converted / downloaded playback copies. */
const APP_MEDIA_DIRS = [TRANSCODE_TMP_DIR, LONGPATH_DIR, path.join(os.tmpdir(), 'cyttos-youtube')]

function isInside(file: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(file))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * Streams local audio files to the player over http://127.0.0.1 with full
 * Range support.
 *
 * Why not a custom protocol: Chromium's media pipeline only seeks reliably
 * when the server answers Range requests with correct 206 / Content-Range /
 * Content-Length / Accept-Ranges headers. A custom protocol (protocol.handle)
 * answered "200, no length, no ranges" for everything, so any seek beyond the
 * already-buffered data (clicking the progress bar in a big FLAC, resuming
 * after a pause) failed with "FFmpegDemuxer: data source error" and the
 * track restarted or was skipped.
 *
 * Safety: bound to loopback only, every URL carries a random per-session
 * token, the Host header must be the loopback address, no CORS headers are
 * sent, and only files that are library songs or the app's own playback
 * copies are served.
 */
export class MediaServer {
  private server: http.Server | null = null
  private port = 0
  private readonly token = randomBytes(16).toString('hex')

  constructor(private db: Database) {}

  /** Base URL; a file is `${base}${encodeURIComponent(absolutePath)}`. */
  get baseUrl(): string {
    return this.port ? `http://127.0.0.1:${this.port}/${this.token}/` : ''
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        void this.handle(req, res).catch((err) => {
          getLogger().debug('media server error', err)
          if (!res.headersSent) res.writeHead(500)
          res.end()
        })
      })
      server.on('clientError', (_err, socket) => socket.destroy())
      server.on('error', (err) => {
        getLogger().error('Media server failed to start', err)
        resolve()
      })
      server.listen(0, '127.0.0.1', () => {
        this.port = (server.address() as { port: number }).port
        this.server = server
        getLogger().info(`Media server listening on 127.0.0.1:${this.port}`)
        resolve()
      })
    })
  }

  stop(): void {
    this.server?.close()
    this.server = null
  }

  private allowed(file: string): boolean {
    if (APP_MEDIA_DIRS.some((d) => isInside(file, d))) return true
    const resolved = path.resolve(file)
    if (this.db.get('SELECT 1 AS x FROM songs WHERE path = ?', [resolved])) return true
    // Windows paths are case-insensitive.
    return Boolean(this.db.get('SELECT 1 AS x FROM songs WHERE LOWER(path) = LOWER(?)', [resolved]))
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      return void res.end()
    }
    if (req.headers.host !== `127.0.0.1:${this.port}`) {
      res.writeHead(403)
      return void res.end()
    }
    const prefix = `/${this.token}/`
    const rawUrl = (req.url ?? '').split('?')[0]
    if (!rawUrl.startsWith(prefix)) {
      res.writeHead(404)
      return void res.end()
    }
    let file: string
    try {
      file = decodeURIComponent(rawUrl.slice(prefix.length))
    } catch {
      res.writeHead(400)
      return void res.end()
    }
    if (!file || !path.isAbsolute(file) || !this.allowed(file)) {
      res.writeHead(404)
      return void res.end()
    }

    let readable: string
    let size: number
    try {
      readable = await playablePath(file)
      const st = await fs.promises.stat(readable)
      if (!st.isFile()) throw new Error('not a file')
      size = st.size
    } catch {
      res.writeHead(404)
      return void res.end()
    }

    const type = AUDIO_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
    const common = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    }
    const range = req.headers.range
    let start = 0
    let end = size - 1
    let status = 200
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
      if (!m || (m[1] === '' && m[2] === '')) {
        res.writeHead(416, { ...common, 'Content-Range': `bytes */${size}` })
        return void res.end()
      }
      if (m[1] === '') {
        // suffix range: the last N bytes
        start = Math.max(0, size - parseInt(m[2], 10))
      } else {
        start = parseInt(m[1], 10)
        if (m[2] !== '') end = Math.min(parseInt(m[2], 10), size - 1)
      }
      if (start >= size || start > end) {
        res.writeHead(416, { ...common, 'Content-Range': `bytes */${size}` })
        return void res.end()
      }
      status = 206
    }
    const headers: http.OutgoingHttpHeaders = { ...common, 'Content-Length': end - start + 1 }
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    res.writeHead(status, headers)
    if (req.method === 'HEAD' || size === 0) return void res.end()

    const stream = fs.createReadStream(readable, { start, end })
    // The player aborts requests all the time (every seek): tear the file
    // stream down together with the connection.
    const abort = (): void => {
      stream.destroy()
    }
    req.on('close', abort)
    res.on('close', abort)
    stream.on('error', () => res.destroy())
    stream.pipe(res)
    return
  }
}
