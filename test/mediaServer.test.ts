import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { MediaServer } from '../src/main/services/mediaServer'
import { TRANSCODE_TMP_DIR } from '../src/main/services/transcode'
import { initLogger } from '../src/main/services/logger'

initLogger(os.tmpdir())

const libraryFile = path.join(os.tmpdir(), `oli-media-lib-${Date.now()}.flac`)
const playbackCopy = path.join(TRANSCODE_TMP_DIR, `oli-media-test-${Date.now()}.m4a`)
const outsideFile = path.join(os.tmpdir(), `oli-media-outside-${Date.now()}.flac`)
const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251))

// Minimal stand-in for the songs table: only the library file is "in the library".
const db = {
  get: (_sql: string, params: unknown[]) => (params[0] === path.resolve(libraryFile) ? { x: 1 } : undefined)
} as never

let server: MediaServer

function request(
  url: string,
  opts: { method?: string; headers?: Record<string, string> } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
      )
    })
    req.on('error', reject)
    req.end()
  })
}

beforeAll(async () => {
  fs.mkdirSync(TRANSCODE_TMP_DIR, { recursive: true })
  fs.writeFileSync(libraryFile, bytes)
  fs.writeFileSync(playbackCopy, bytes)
  fs.writeFileSync(outsideFile, bytes)
  server = new MediaServer(db)
  await server.start()
})

afterAll(() => {
  server.stop()
  for (const f of [libraryFile, playbackCopy, outsideFile]) fs.rmSync(f, { force: true })
})

const urlFor = (file: string): string => server.baseUrl + encodeURIComponent(file)

describe('media server', () => {
  it('serves a whole file with length and range support advertised', async () => {
    const r = await request(urlFor(libraryFile))
    expect(r.status).toBe(200)
    expect(r.headers['accept-ranges']).toBe('bytes')
    expect(r.headers['content-length']).toBe('1000')
    expect(r.headers['content-type']).toBe('audio/flac')
    expect(r.body.equals(bytes)).toBe(true)
  })

  it('answers seeks with correct 206 partial content', async () => {
    const r = await request(urlFor(libraryFile), { headers: { Range: 'bytes=600-' } })
    expect(r.status).toBe(206)
    expect(r.headers['content-range']).toBe('bytes 600-999/1000')
    expect(r.headers['content-length']).toBe('400')
    expect(r.body.equals(bytes.subarray(600))).toBe(true)

    const mid = await request(urlFor(libraryFile), { headers: { Range: 'bytes=10-19' } })
    expect(mid.status).toBe(206)
    expect(mid.headers['content-range']).toBe('bytes 10-19/1000')
    expect(mid.body.equals(bytes.subarray(10, 20))).toBe(true)

    const suffix = await request(urlFor(libraryFile), { headers: { Range: 'bytes=-100' } })
    expect(suffix.status).toBe(206)
    expect(suffix.headers['content-range']).toBe('bytes 900-999/1000')
  })

  it('rejects ranges past the end of the file', async () => {
    const r = await request(urlFor(libraryFile), { headers: { Range: 'bytes=5000-' } })
    expect(r.status).toBe(416)
    expect(r.headers['content-range']).toBe('bytes */1000')
  })

  it('supports HEAD', async () => {
    const r = await request(urlFor(libraryFile), { method: 'HEAD' })
    expect(r.status).toBe(200)
    expect(r.headers['content-length']).toBe('1000')
    expect(r.body.length).toBe(0)
  })

  it('serves the app own playback copies', async () => {
    const r = await request(urlFor(playbackCopy), { headers: { Range: 'bytes=0-9' } })
    expect(r.status).toBe(206)
    expect(r.headers['content-type']).toBe('audio/mp4')
  })

  it('refuses files that are not in the library or the app folders', async () => {
    expect((await request(urlFor(outsideFile))).status).toBe(404)
    expect((await request(urlFor('C:\\Windows\\win.ini'))).status).toBe(404)
    expect((await request(urlFor('relative/path.flac'))).status).toBe(404)
  })

  it('needs the session token and a loopback Host header', async () => {
    const noToken = server.baseUrl.replace(/\/[0-9a-f]{32}\/$/, '/deadbeef/') + encodeURIComponent(libraryFile)
    expect((await request(noToken)).status).toBe(404)
    const wrongHost = await request(urlFor(libraryFile), { headers: { Host: 'evil.example' } })
    expect(wrongHost.status).toBe(403)
    expect(wrongHost.headers['access-control-allow-origin']).toBeUndefined()
  })
})
