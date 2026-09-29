import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { getLogger } from './logger'
import type { YtEngineSource, YtEngineStatus } from '@shared/types'

const RELEASE_API = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest'
const DOWNLOAD_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'
const USER_AGENT = 'Oli/1.0 (yt-dlp engine updater)'
const CHECK_EVERY_MS = 12 * 3600_000
const FIRST_CHECK_MS = 3000
const BUSY_RETRY_MS = 60_000
const MAX_BUSY_RETRIES = 5

/** Release asset name and installed file name per platform. */
const ASSETS: Record<string, { asset: string; file: string }> = {
  win32: { asset: 'yt-dlp.exe', file: 'yt-dlp.exe' },
  darwin: { asset: 'yt-dlp_macos', file: 'yt-dlp' },
  linux: { asset: 'yt-dlp_linux', file: 'yt-dlp' }
}

/** yt-dlp versions are dates: 2026.08.19, optionally with a build suffix (2026.08.19.1234). */
export function isValidVersion(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/.test(v)
}

/** Negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** The sha256 published for `asset` in a SHA2-256SUMS file, or null. */
export function checksumFor(sums: string, asset: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const [hash, name] = line.trim().split(/\s+/)
    if (hash && name && name.replace(/^\*/, '') === asset && /^[0-9a-f]{64}$/i.test(hash)) {
      return hash.toLowerCase()
    }
  }
  return null
}

export interface YtdlpEngineOptions {
  /** Writable folder for the downloaded copy (userData/bin). */
  userDir: string
  /** The copy shipped with the app (resources/bin), if present. */
  bundledPath: () => string | null
  /** A yt-dlp found on the PC (PATH), if any. */
  systemPath: () => string | null
  /** Setting: install missing / newer versions without asking. */
  autoUpdate: () => boolean
  /** A yt-dlp process is running right now (its exe cannot be replaced). */
  isBusy: () => boolean
  /** Called after a new copy was installed (old resolved stream URLs must go). */
  onInstalled: () => void
  // Test hooks; the defaults talk to GitHub and run the real exe.
  platform?: string
  apiUrl?: string
  downloadBase?: string
  runVersion?: (file: string) => Promise<string | null>
  fetchImpl?: typeof fetch
}

function defaultRunVersion(file: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(file, ['--version'], { timeout: 15_000, windowsHide: true }, (err, out) => {
        const v = err ? null : String(out).trim()
        resolve(v || null)
      })
    } catch {
      // A file that is not a program (corrupt download, blocked by antivirus) makes Windows
      // throw "spawn UNKNOWN" instead of reporting an error.
      resolve(null)
    }
  })
}

/**
 * Keeps the YouTube engine (yt-dlp) usable: finds it, notices when it is
 * missing / broken / outdated, and installs the official release into a
 * folder the app can always write to.
 *
 * Which copy is used: the downloaded one (userData/bin) if present, else the
 * one shipped with the app, else one found on the PC. A downloaded copy that
 * is not newer than the shipped one is deleted, so an app update is never
 * shadowed by an older download.
 *
 * Downloads only come from github.com/yt-dlp/yt-dlp releases; the file must
 * match the SHA-256 in the release's SHA2-256SUMS, and must run and report
 * the release's version before it replaces anything. A failed install leaves
 * the working copy untouched.
 */
export class YtdlpEngine extends EventEmitter {
  private current: YtEngineStatus = {
    state: 'checking',
    version: null,
    latest: null,
    source: null,
    path: null,
    message: null,
    auto: true
  }
  private installing = false
  private busyRetries = 0
  private timers: NodeJS.Timeout[] = []
  private readonly plat: string
  private readonly fetchFn: typeof fetch
  private readonly runVersion: (file: string) => Promise<string | null>

  constructor(private opts: YtdlpEngineOptions) {
    super()
    this.plat = opts.platform ?? process.platform
    this.fetchFn = opts.fetchImpl ?? fetch
    this.runVersion = opts.runVersion ?? defaultRunVersion
  }

  private get fileName(): string {
    return (ASSETS[this.plat] ?? ASSETS.linux).file
  }

  private get userPath(): string {
    return path.join(this.opts.userDir, this.fileName)
  }

  get status(): YtEngineStatus {
    return { ...this.current, auto: this.opts.autoUpdate() }
  }

  private set(patch: Partial<YtEngineStatus>): void {
    this.current = { ...this.current, ...patch }
    this.emit('status', this.status)
  }

  /** The executable to run right now (synchronous; used by every yt-dlp call). */
  resolve(): { path: string; source: YtEngineSource } | null {
    if (fs.existsSync(this.userPath)) return { path: this.userPath, source: 'user' }
    const bundled = this.opts.bundledPath()
    if (bundled) return { path: bundled, source: 'bundled' }
    const system = this.opts.systemPath()
    if (system) return { path: system, source: 'system' }
    return null
  }

  /** Every yt-dlp exe this app may have started (for cleaning up orphan processes). */
  paths(): string[] {
    return [this.userPath, this.opts.bundledPath()].filter((p): p is string => Boolean(p))
  }

  start(): void {
    const first = setTimeout(() => void this.refresh(true), FIRST_CHECK_MS)
    const every = setInterval(() => void this.refresh(true), CHECK_EVERY_MS)
    first.unref?.()
    every.unref?.()
    this.timers.push(first, every)
  }

  stop(): void {
    for (const t of this.timers) {
      clearTimeout(t)
      clearInterval(t)
    }
    this.timers = []
  }

  /** The newest released version, or null when GitHub cannot be reached. */
  async latestVersion(): Promise<string | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    try {
      const res = await this.fetchFn(this.opts.apiUrl ?? RELEASE_API, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
        signal: controller.signal
      })
      if (!res.ok) return null
      const tag = ((await res.json()) as { tag_name?: unknown }).tag_name
      return isValidVersion(tag) ? tag : null
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Look at what is installed and (with `network`) what is newest, then act
   * on it: with auto-update on, install what is missing or outdated;
   * otherwise report it so the UI can offer a button.
   */
  async refresh(network: boolean): Promise<YtEngineStatus> {
    if (this.installing) return this.status
    const found = this.resolve()
    if (!found) {
      this.set({ state: 'missing', version: null, source: null, path: null, message: null })
      return this.finish(network, 'missing')
    }
    let version = await this.runVersion(found.path)
    if (!version) {
      this.set({ state: 'broken', version: null, source: found.source, path: found.path, message: null })
      return this.finish(network, 'broken')
    }
    // A downloaded copy that the shipped one has caught up with is just clutter.
    if (found.source === 'user') {
      const bundled = this.opts.bundledPath()
      const bundledVersion = bundled ? await this.runVersion(bundled) : null
      if (bundled && bundledVersion && compareVersions(bundledVersion, version) >= 0) {
        try {
          fs.rmSync(this.userPath, { force: true })
          version = bundledVersion
          found.path = bundled
          found.source = 'bundled'
          getLogger().info(`Removed downloaded yt-dlp ${bundledVersion} copy: the app ships the same or newer`)
        } catch {
          // still in use; harmless
        }
      }
    }
    this.set({ state: 'ok', version, source: found.source, path: found.path, message: null })
    if (!network) return this.status
    this.set({ state: 'checking' })
    const latest = await this.latestVersion()
    if (latest && compareVersions(version, latest) < 0) {
      this.set({ state: 'update-available', latest })
      return this.finish(true, 'update-available')
    }
    this.set({ state: 'ok', latest })
    return this.status
  }

  private async finish(network: boolean, state: 'missing' | 'broken' | 'update-available'): Promise<YtEngineStatus> {
    if (network && state !== 'update-available') {
      const latest = await this.latestVersion()
      this.set({ latest })
    }
    if (network && this.opts.autoUpdate()) return this.install()
    return this.status
  }

  /** Download, verify and install the newest release. */
  async install(): Promise<YtEngineStatus> {
    if (this.installing) return this.status
    this.installing = true
    const before = this.current
    this.set({ state: 'installing', message: null })
    const tmp = path.join(this.opts.userDir, `yt-dlp.download${path.extname(this.fileName)}`)
    try {
      const target = ASSETS[this.plat]
      if (!target) throw new Error(`No yt-dlp build is available for ${this.plat}`)
      fs.mkdirSync(this.opts.userDir, { recursive: true })
      const base = this.opts.downloadBase ?? DOWNLOAD_BASE

      const sumsRes = await this.fetchFn(`${base}/SHA2-256SUMS`, { headers: { 'User-Agent': USER_AGENT } })
      if (!sumsRes.ok) throw new Error(`Could not fetch the checksum list (HTTP ${sumsRes.status})`)
      const expected = checksumFor(await sumsRes.text(), target.asset)
      if (!expected) throw new Error('The release has no checksum for this file')

      const res = await this.fetchFn(`${base}/${target.asset}`, {
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'follow'
      })
      if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`)
      const bytes = Buffer.from(await res.arrayBuffer())
      const actual = createHash('sha256').update(bytes).digest('hex')
      if (actual !== expected) throw new Error('The downloaded file does not match its published checksum, so it was not installed')
      fs.writeFileSync(tmp, bytes)
      if (this.plat !== 'win32') fs.chmodSync(tmp, 0o755)

      // It must run, and be the release we think it is, before it replaces anything.
      const version = await this.runVersion(tmp)
      if (!version) throw new Error('The downloaded file does not run on this PC (blocked by antivirus?)')
      const latest = await this.latestVersion()
      if (latest && version !== latest && compareVersions(version, latest) < 0) {
        throw new Error(`Downloaded yt-dlp ${version} is older than the latest release ${latest}`)
      }

      // Replacing the exe a running yt-dlp is using fails on Windows: wait instead of guessing.
      if (this.opts.isBusy() && fs.existsSync(this.userPath)) {
        throw Object.assign(new Error('yt-dlp is running'), { code: 'EBUSY' })
      }
      await this.replaceFile(tmp, this.userPath)
      this.busyRetries = 0
      this.opts.onInstalled()
      getLogger().info(`Installed yt-dlp ${version} into ${this.userPath}`)
      this.installing = false
      this.set({ state: 'ok', version, latest: latest ?? version, source: 'user', path: this.userPath, message: `YouTube engine updated to ${version}` })
      return this.status
    } catch (err) {
      fs.rmSync(tmp, { force: true })
      const e = err as NodeJS.ErrnoException
      const inUse = e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES'
      getLogger().warn('yt-dlp install failed', e.message)
      this.installing = false
      if (inUse && this.busyRetries < MAX_BUSY_RETRIES) {
        // The old exe is running right now: try again in a minute.
        this.busyRetries++
        const t = setTimeout(() => void this.install(), BUSY_RETRY_MS)
        t.unref?.()
        this.timers.push(t)
        this.set({ ...before, state: 'update-available', message: 'The YouTube engine is busy right now; the update will retry in a minute.' })
      } else {
        this.set({ ...before, state: 'failed', message: e.message || 'Install failed' })
      }
      return this.status
    }
  }

  /** Move `from` over `to`, retrying briefly when Windows still holds the old file. */
  private async replaceFile(from: string, to: string): Promise<void> {
    let lastErr: unknown = null
    for (let i = 0; i < 6; i++) {
      try {
        fs.renameSync(from, to)
        return
      } catch (err) {
        lastErr = err
        await new Promise((r) => setTimeout(r, 400))
      }
    }
    throw lastErr
  }
}
