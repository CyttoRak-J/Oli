import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { YtdlpEngine, checksumFor, compareVersions, isValidVersion } from '../src/main/services/ytdlpEngine'
import { initLogger } from '../src/main/services/logger'

initLogger(os.tmpdir())

describe('version and checksum helpers', () => {
  it('validates and compares yt-dlp versions', () => {
    expect(isValidVersion('2026.08.19')).toBe(true)
    expect(isValidVersion('2026.08.19.1234')).toBe(true)
    expect(isValidVersion('v2026.08.19')).toBe(false)
    expect(isValidVersion('latest')).toBe(false)
    expect(isValidVersion(20260819)).toBe(false)
    expect(compareVersions('2025.12.08', '2026.08.19')).toBeLessThan(0)
    expect(compareVersions('2026.08.19', '2026.08.19')).toBe(0)
    expect(compareVersions('2026.09.01', '2026.08.19')).toBeGreaterThan(0)
    expect(compareVersions('2026.08.19.5', '2026.08.19')).toBeGreaterThan(0)
    expect(compareVersions('2026.10.01', '2026.9.30')).toBeGreaterThan(0)
  })

  it('finds the checksum of one asset in a SHA2-256SUMS file', () => {
    const h = 'a'.repeat(64)
    const sums = `${'b'.repeat(64)}  yt-dlp\n${h} *yt-dlp.exe\r\nnotahash  yt-dlp_macos\n`
    expect(checksumFor(sums, 'yt-dlp.exe')).toBe(h)
    expect(checksumFor(sums, 'yt-dlp_macos')).toBeNull()
    expect(checksumFor(sums, 'missing.exe')).toBeNull()
  })
})

/** A local stand-in for GitHub: a release API, a checksum list and the "exe" (plain bytes). */
describe('YtdlpEngine', () => {
  let dir: string
  let server: http.Server
  let base: string
  let latest = '2026.09.10'
  let served: Buffer
  let sums: string
  let apiDown = false

  const versionOf = async (file: string): Promise<string | null> => {
    const text = fs.readFileSync(file, 'utf8')
    return text.startsWith('fake-ytdlp-') ? text.slice('fake-ytdlp-'.length).trim() : null
  }
  const setRelease = (version: string, opts: { badSum?: boolean; bytes?: Buffer } = {}): void => {
    latest = version
    served = opts.bytes ?? Buffer.from(`fake-ytdlp-${version}`)
    const hash = opts.badSum ? '0'.repeat(64) : createHash('sha256').update(served).digest('hex')
    sums = `${hash}  yt-dlp.exe\n`
  }

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/api') {
        if (apiDown) {
          res.writeHead(500)
          return void res.end()
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return void res.end(JSON.stringify({ tag_name: latest }))
      }
      if (req.url === '/dl/SHA2-256SUMS') return void res.end(sums)
      if (req.url === '/dl/yt-dlp.exe') return void res.end(served)
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => server.close())

  let bundled: string | null
  let system: string | null
  let auto: boolean
  let busy: boolean
  let installedCount: number

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oli-yt-'))
    bundled = null
    system = null
    auto = false
    busy = false
    installedCount = 0
    apiDown = false
    setRelease('2026.09.10')
  })

  const write = (file: string, version: string): string => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `fake-ytdlp-${version}`)
    return file
  }
  const make = (): YtdlpEngine =>
    new YtdlpEngine({
      userDir: path.join(dir, 'user'),
      bundledPath: () => bundled,
      systemPath: () => system,
      autoUpdate: () => auto,
      isBusy: () => busy,
      onInstalled: () => {
        installedCount++
      },
      platform: 'win32',
      apiUrl: `${base}/api`,
      downloadBase: `${base}/dl`,
      runVersion: versionOf
    })

  it('prefers the downloaded copy, then the shipped one, then the PC copy', () => {
    const engine = make()
    expect(engine.resolve()).toBeNull()
    system = write(path.join(dir, 'sys', 'yt-dlp.exe'), '2025.12.08')
    expect(engine.resolve()?.source).toBe('system')
    bundled = write(path.join(dir, 'app', 'yt-dlp.exe'), '2026.08.19')
    expect(engine.resolve()?.source).toBe('bundled')
    write(path.join(dir, 'user', 'yt-dlp.exe'), '2026.09.10')
    expect(engine.resolve()?.source).toBe('user')
    expect(engine.paths()).toHaveLength(2)
  })

  it('reports a missing engine without installing when automatic updates are off', async () => {
    const st = await make().refresh(true)
    expect(st.state).toBe('missing')
    expect(st.latest).toBe('2026.09.10')
    expect(st.auto).toBe(false)
    expect(fs.existsSync(path.join(dir, 'user', 'yt-dlp.exe'))).toBe(false)
  })

  it('installs a missing engine by itself when automatic updates are on', async () => {
    auto = true
    const engine = make()
    const seen: string[] = []
    engine.on('status', (s) => seen.push(s.state))
    const st = await engine.refresh(true)
    expect(st).toMatchObject({ state: 'ok', version: '2026.09.10', source: 'user' })
    expect(st.message).toMatch(/updated to 2026.09.10/)
    expect(seen).toContain('installing')
    expect(installedCount).toBe(1)
    expect(fs.readFileSync(path.join(dir, 'user', 'yt-dlp.exe'), 'utf8')).toBe('fake-ytdlp-2026.09.10')
    expect(fs.readdirSync(path.join(dir, 'user'))).toEqual(['yt-dlp.exe'])
  })

  it('reports an outdated engine, then updates it on request', async () => {
    bundled = write(path.join(dir, 'app', 'yt-dlp.exe'), '2026.08.19')
    const engine = make()
    const st = await engine.refresh(true)
    expect(st).toMatchObject({ state: 'update-available', version: '2026.08.19', latest: '2026.09.10' })
    const done = await engine.install()
    expect(done).toMatchObject({ state: 'ok', version: '2026.09.10', source: 'user' })
    expect(fs.readFileSync(bundled, 'utf8')).toBe('fake-ytdlp-2026.08.19') // the shipped copy is never touched
  })

  it('does nothing when the engine is current, or when GitHub cannot be reached', async () => {
    bundled = write(path.join(dir, 'app', 'yt-dlp.exe'), '2026.09.10')
    expect((await make().refresh(true)).state).toBe('ok')
    bundled = write(path.join(dir, 'app2', 'yt-dlp.exe'), '2026.08.19')
    apiDown = true
    auto = true
    const st = await make().refresh(true)
    expect(st).toMatchObject({ state: 'ok', latest: null })
  })

  it('rejects a download whose checksum does not match and keeps the working copy', async () => {
    bundled = write(path.join(dir, 'app', 'yt-dlp.exe'), '2026.08.19')
    const user = write(path.join(dir, 'user', 'yt-dlp.exe'), '2026.08.20')
    setRelease('2026.09.10', { badSum: true })
    const st = await make().install()
    expect(st.state).toBe('failed')
    expect(st.message).toMatch(/checksum/i)
    expect(fs.readFileSync(user, 'utf8')).toBe('fake-ytdlp-2026.08.20')
    expect(fs.readdirSync(path.join(dir, 'user'))).toEqual(['yt-dlp.exe'])
    expect(installedCount).toBe(0)
  })

  it('rejects a file that does not run, and one older than the latest release', async () => {
    setRelease('2026.09.10', { bytes: Buffer.from('MZ not really a program') })
    const notRunnable = await make().install()
    expect(notRunnable.state).toBe('failed')
    expect(notRunnable.message).toMatch(/does not run/)

    setRelease('2026.09.10', { bytes: Buffer.from('fake-ytdlp-2025.01.01') })
    const stale = await make().install()
    expect(stale.state).toBe('failed')
    expect(stale.message).toMatch(/older than the latest/)
    expect(fs.existsSync(path.join(dir, 'user', 'yt-dlp.exe'))).toBe(false)
  })

  it('flags an engine that is present but broken, and repairs it when automatic', async () => {
    bundled = path.join(dir, 'app', 'yt-dlp.exe')
    fs.mkdirSync(path.dirname(bundled), { recursive: true })
    fs.writeFileSync(bundled, 'garbage')
    expect((await make().refresh(true)).state).toBe('broken')
    auto = true
    const st = await make().refresh(true)
    expect(st).toMatchObject({ state: 'ok', source: 'user', version: '2026.09.10' })
  })

  it('removes a downloaded copy once the shipped one is as new', async () => {
    write(path.join(dir, 'user', 'yt-dlp.exe'), '2026.08.19')
    bundled = write(path.join(dir, 'app', 'yt-dlp.exe'), '2026.08.19')
    setRelease('2026.08.19')
    const st = await make().refresh(true)
    expect(st).toMatchObject({ state: 'ok', source: 'bundled' })
    expect(fs.existsSync(path.join(dir, 'user', 'yt-dlp.exe'))).toBe(false)
  })

  it('retries later instead of failing when the running exe cannot be replaced', async () => {
    write(path.join(dir, 'user', 'yt-dlp.exe'), '2026.08.19')
    busy = true
    const engine = make()
    const st = await engine.install()
    expect(st.state).toBe('update-available')
    expect(st.message).toMatch(/retry/)
    engine.stop()
    expect(fs.readFileSync(path.join(dir, 'user', 'yt-dlp.exe'), 'utf8')).toBe('fake-ytdlp-2026.08.19')
  })

  it('treats a real file that is not a program as broken (uses the real process launcher)', async () => {
    bundled = path.join(dir, 'app', 'yt-dlp.exe')
    fs.mkdirSync(path.dirname(bundled), { recursive: true })
    fs.writeFileSync(bundled, 'MZ this is not a real program')
    const engine = new YtdlpEngine({
      userDir: path.join(dir, 'user'),
      bundledPath: () => bundled,
      systemPath: () => null,
      autoUpdate: () => false,
      isBusy: () => false,
      onInstalled: () => undefined
    })
    expect((await engine.refresh(false)).state).toBe('broken')
  })
})
