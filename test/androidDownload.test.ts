import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync, execFile } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseFile } from 'music-metadata'

// The Android download engine (DownloadEngine.java: resume, pause, checksum, tags) is plain Java: compile it with the
// PC's JDK and run it against a local HTTP server that misbehaves on purpose. Skipped when no JDK is installed.
const hasJdk = spawnSync('javac', ['-version']).status === 0
const repo = path.resolve(__dirname, '..')
const javaDir = path.join(repo, 'android/app/src/main/java/com/cyttos/oli')

let work = ''
let classes = ''
let server: http.Server
let base = ''

interface Behaviour {
  body: Buffer
  /** close the connection after this many bytes on the FIRST request only */
  dropFirstAfter?: number
  /** ignore Range headers (always answer 200 with the whole body) */
  ignoreRange?: boolean
  /** delay in ms between 64 KB chunks */
  throttleMs?: number
  status?: number
}
const routes = new Map<string, Behaviour>()
const seen: Array<{ name: string; range: string | undefined }> = []
const served = new Map<string, number>()

function startServer(): Promise<void> {
  server = http.createServer((req, res) => {
    const name = (req.url ?? '').split('?')[0].slice(1)
    const b = routes.get(name)
    seen.push({ name, range: req.headers.range })
    if (!b) {
      res.writeHead(404).end()
      return
    }
    if (b.status && b.status !== 200) {
      res.writeHead(b.status).end()
      return
    }
    const count = (served.get(name) ?? 0) + 1
    served.set(name, count)
    let start = 0
    const m = !b.ignoreRange && req.headers.range ? /bytes=(\d+)-/.exec(req.headers.range) : null
    if (m) start = Number(m[1])
    const slice = b.body.subarray(start)
    if (m) {
      res.writeHead(206, {
        'Content-Length': slice.length,
        'Content-Range': `bytes ${start}-${b.body.length - 1}/${b.body.length}`,
        'Accept-Ranges': 'bytes'
      })
    } else {
      res.writeHead(200, { 'Content-Length': slice.length, 'Accept-Ranges': 'bytes' })
    }
    const limit = count === 1 && b.dropFirstAfter != null ? b.dropFirstAfter : slice.length
    let sent = 0
    const step = (): void => {
      if (sent >= limit) {
        if (limit < slice.length) req.socket.destroy()
        else res.end()
        return
      }
      const end = Math.min(limit, sent + 65536)
      res.write(slice.subarray(sent, end), () => {
        sent = end
        if (b.throttleMs) setTimeout(step, b.throttleMs)
        else step()
      })
    }
    step()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      resolve()
    })
  })
}

const md5 = (b: Buffer): string => crypto.createHash('md5').update(b).digest('hex')

/** Runs one download through the Java engine; resolves with the printed lines. */
function download(name: string, args: string[]): Promise<{ lines: string[]; states: string[]; dest: string }> {
  const dest = path.join(work, `out-${Math.random().toString(36).slice(2)}-${name}`)
  return new Promise((resolve, reject) => {
    execFile('java', ['-cp', classes, 'com.cyttos.oli.DownloadCli', `${base}/${name}`, dest, ...args], { encoding: 'utf8' }, (err, stdout) => {
      if (err && !stdout) return reject(err)
      const lines = stdout.split(/\r?\n/).filter(Boolean)
      resolve({ lines, states: lines.filter((l) => l.startsWith('state=')).map((l) => l.split(' ')[0].slice(6)), dest })
    })
  })
}

describe.skipIf(!hasJdk)('Android download engine (compiled with the PC JDK)', () => {
  beforeAll(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'oli-dl-'))
    classes = path.join(work, 'classes')
    fs.mkdirSync(classes)
    execFileSync('javac', [
      '-d',
      classes,
      ...['TagFields', 'FlacTagWriter', 'Id3TagWriter', 'DownloadEngine'].map((n) => path.join(javaDir, `${n}.java`)),
      path.join(repo, 'scripts/android-tags/com/cyttos/oli/DownloadCli.java')
    ])
    await startServer()
  })
  afterAll(() => {
    server?.close()
    fs.rmSync(work, { recursive: true, force: true })
  })

  it('downloads a file and checks size and MD5', async () => {
    const body = crypto.randomBytes(3_000_000)
    routes.set('plain.bin', { body })
    const r = await download('plain.bin', [`size=${body.length}`, `md5=${md5(body)}`])
    expect(r.states).toEqual(['queued', 'downloading', 'completed'])
    expect(fs.readFileSync(r.dest).equals(body)).toBe(true)
    expect(fs.existsSync(r.dest + '.part')).toBe(false)
    expect(r.lines.find((l) => l.startsWith('state=completed'))).toContain(`md5=${md5(body)}`)
  })

  it('a dropped connection is resumed from where it stopped (HTTP Range) and the result is byte-identical', async () => {
    const body = crypto.randomBytes(2_500_000)
    routes.set('drop.bin', { body, dropFirstAfter: 1_000_000 })
    const before = seen.length
    const r = await download('drop.bin', [`size=${body.length}`, `md5=${md5(body)}`, 'retries=2'])
    expect(r.states.at(-1)).toBe('completed')
    expect(fs.readFileSync(r.dest).equals(body)).toBe(true)
    const requests = seen.slice(before).filter((s) => s.name === 'drop.bin')
    expect(requests).toHaveLength(2)
    expect(requests[0].range).toBeUndefined()
    expect(requests[1].range).toMatch(/^bytes=\d{6,}-$/) // continued after ~1 MB, not from 0
  })

  it('without retries a dropped connection fails, keeps the partial file, and a new attempt finishes it', async () => {
    const body = crypto.randomBytes(2_000_000)
    routes.set('drop2.bin', { body, dropFirstAfter: 700_000 })
    const dest = path.join(work, 'drop2-dest.bin')
    // first run fails
    const first = await new Promise<string>((resolve) =>
      execFile('java', ['-cp', classes, 'com.cyttos.oli.DownloadCli', `${base}/drop2.bin`, dest, `size=${body.length}`, 'retries=0'], { encoding: 'utf8' }, (_e, out) => resolve(out))
    )
    expect(first).toContain('state=failed')
    expect(fs.existsSync(dest + '.part')).toBe(true)
    expect(fs.statSync(dest + '.part').size).toBeGreaterThan(0)
    expect(fs.existsSync(dest)).toBe(false)
    // second run (the "retry" button) continues
    const second = await new Promise<string>((resolve) =>
      execFile('java', ['-cp', classes, 'com.cyttos.oli.DownloadCli', `${base}/drop2.bin`, dest, `size=${body.length}`, `md5=${md5(body)}`], { encoding: 'utf8' }, (_e, out) => resolve(out))
    )
    expect(second).toContain('state=completed')
    expect(fs.readFileSync(dest).equals(body)).toBe(true)
  })

  it('pause keeps the partial file, resume continues with Range and finishes identical', async () => {
    const body = crypto.randomBytes(3_000_000)
    routes.set('slow.bin', { body, throttleMs: 25 })
    const before = seen.length
    const r = await download('slow.bin', [`size=${body.length}`, `md5=${md5(body)}`, 'pauseAfterMs=400', 'resumeAfterMs=400'])
    expect(r.states).toContain('paused')
    expect(r.states.at(-1)).toBe('completed')
    expect(fs.readFileSync(r.dest).equals(body)).toBe(true)
    const requests = seen.slice(before).filter((s) => s.name === 'slow.bin')
    expect(requests.length).toBeGreaterThanOrEqual(2)
    expect(requests[1].range).toBeDefined()
  })

  it('a server that ignores Range makes the resume start over and still ends correct', async () => {
    const body = crypto.randomBytes(1_500_000)
    routes.set('norange.bin', { body, ignoreRange: true, dropFirstAfter: 500_000 })
    const r = await download('norange.bin', [`size=${body.length}`, `md5=${md5(body)}`, 'retries=2'])
    expect(r.states.at(-1)).toBe('completed')
    expect(fs.readFileSync(r.dest).equals(body)).toBe(true)
  })

  it('a wrong checksum deletes the file and reports it', async () => {
    const body = crypto.randomBytes(400_000)
    routes.set('bad.bin', { body })
    const r = await download('bad.bin', [`size=${body.length}`, `md5=${'0'.repeat(32)}`])
    expect(r.states.at(-1)).toBe('failed')
    expect(r.lines.join('\n')).toContain('Checksum mismatch')
    expect(fs.existsSync(r.dest)).toBe(false)
    expect(fs.existsSync(r.dest + '.part')).toBe(false)
  })

  it('HTTP errors fail at once (404 is not retried) and nothing is left behind', async () => {
    const before = seen.length
    const r = await download('missing.bin', ['retries=3'])
    expect(r.states.at(-1)).toBe('failed')
    expect(r.lines.join('\n')).toContain('HTTP 404')
    expect(seen.slice(before).filter((s) => s.name === 'missing.bin')).toHaveLength(1)
    expect(fs.existsSync(r.dest)).toBe(false)
  })

  it('a file shorter than announced is reported and can be continued', async () => {
    const body = crypto.randomBytes(500_000)
    routes.set('short.bin', { body })
    const r = await download('short.bin', [`size=${body.length + 1000}`])
    expect(r.states.at(-1)).toBe('failed')
    expect(r.lines.join('\n')).toMatch(/Incomplete|Wrong size/)
  })

  it('cancel stops the download and removes the partial file', async () => {
    const body = crypto.randomBytes(4_000_000)
    routes.set('cancel.bin', { body, throttleMs: 40 })
    const r = await download('cancel.bin', ['cancelAfterMs=400'])
    expect(r.states.at(-1)).toBe('canceled')
    expect(fs.existsSync(r.dest)).toBe(false)
    expect(fs.existsSync(r.dest + '.part')).toBe(false)
  })

  it('writes tags and the cover into the finished FLAC file', async () => {
    // minimal FLAC (STREAMINFO + padding + fake audio)
    const info = Buffer.alloc(34)
    info.writeUInt16BE(4096, 0)
    info.writeUInt16BE(4096, 2)
    info[10] = (44100 >> 12) & 0xff
    info[11] = (44100 >> 4) & 0xff
    info[12] = ((44100 & 0xf) << 4) | (1 << 1)
    info[13] = 15 << 4
    info.writeUInt32BE(441000, 14)
    const flac = Buffer.concat([
      Buffer.from('fLaC'),
      Buffer.from([0x00, 0, 0, 34]),
      info,
      Buffer.from([0x81, 0, 0x01, 0x00]),
      Buffer.alloc(256),
      crypto.randomBytes(100_000)
    ])
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 100, 0, 100, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]), crypto.randomBytes(1000), Buffer.from([0xff, 0xd9])])
    routes.set('song.flac', { body: flac })
    routes.set('cover.jpg', { body: jpeg })
    const r = await download('song.flac', [`size=${flac.length}`, `md5=${md5(flac)}`, 'title=Downloaded song', 'artist=Some Band', `coverUrl=${base}/cover.jpg`])
    expect(r.states.at(-1)).toBe('completed')
    expect(r.lines.find((l) => l.startsWith('state=completed'))).toContain('tagged=true')
    const meta = await parseFile(r.dest)
    expect(meta.common.title).toBe('Downloaded song')
    expect(meta.common.artist).toBe('Some Band')
    expect(Buffer.from(meta.common.picture![0].data).equals(jpeg)).toBe(true)
  })

  it('a download whose cover cannot be fetched still completes (tags without cover)', async () => {
    const info = Buffer.alloc(34)
    info.writeUInt16BE(4096, 0)
    info.writeUInt16BE(4096, 2)
    info[10] = 0x0a
    info[11] = 0xc4
    info[12] = 0x42
    info[13] = 0xf0
    info.writeUInt32BE(441000, 14)
    const flac = Buffer.concat([Buffer.from('fLaC'), Buffer.from([0x80, 0, 0, 34]), info, crypto.randomBytes(50_000)])
    routes.set('song2.flac', { body: flac })
    const r = await download('song2.flac', [`size=${flac.length}`, 'title=No cover', `coverUrl=${base}/nothing.jpg`])
    expect(r.states.at(-1)).toBe('completed')
    const meta = await parseFile(r.dest)
    expect(meta.common.title).toBe('No cover')
    expect(meta.common.picture ?? []).toHaveLength(0)
  })
})
