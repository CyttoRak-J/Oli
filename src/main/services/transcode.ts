import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { getLogger } from './logger'

const TMP_DIR = path.join(os.tmpdir(), 'cyttos-transcode')

interface QueueItem {
  file: string
  key: string
  resolvers: Array<(value: string | null) => void>
}

/**
 * Fallback decoder: when Chromium cannot play a local file (e.g. some opus
 * files, ape/wavpack/…), transcode it once to MP3 with ffmpeg and play the
 * cached result. MP3 (libmp3lame) is available in the GPL ffmpeg builds that
 * ship with yt-dlp, and always plays in Chromium.
 *
 * Work is serialized through a single worker (one ffmpeg at a time, keeps CPU
 * low). On-demand requests jump the queue; scan-time pre-transcoding fills the
 * cache in the background so playback is instant later.
 */
export class TranscodeService {
  private cache = new Map<string, string>()
  private durationCache = new Map<string, number>()
  private ffmpegBin: string | null | undefined = undefined
  private ffprobeBin: string | null | undefined = undefined

  private pending: QueueItem[] = []
  private inflight = new Map<string, Promise<string | null>>()
  private running = false

  constructor() {
    // Remove leftover 0-byte outputs from previously interrupted runs.
    setImmediate(() => {
      try {
        if (!fs.existsSync(TMP_DIR)) return
        for (const entry of fs.readdirSync(TMP_DIR)) {
          const p = path.join(TMP_DIR, entry)
          try {
            if (fs.statSync(p).size <= 0) fs.unlinkSync(p)
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    })
  }

  /** Cache lookup without spawning anything. */
  cachedTranscode(file: string): string | null {
    if (!file || !fs.existsSync(file)) return null
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size === 0) return null
    const cached = this.cache.get(cacheKey(file, stat))
    if (cached && fs.existsSync(cached) && fs.statSync(cached).size > 0) return cached
    return null
  }

  /** Returns a path to a playable MP3 for the given file, or null on failure. */
  async transcodeToMp3(file: string): Promise<string | null> {
    try {
      if (!file || !fs.existsSync(file)) return null
      const stat = fs.statSync(file)
      if (!stat.isFile() || stat.size === 0) return null
      const key = cacheKey(file, stat)
      const cached = this.cache.get(key)
      if (cached && fs.existsSync(cached) && fs.statSync(cached).size > 0) return cached
      return await this.enqueue(file, key, true)
    } catch (err) {
      getLogger().debug(`Transcode failed for ${file}`, err)
      return null
    }
  }

  /** Queue a file for background transcoding (used after scans). */
  preTranscode(file: string): void {
    try {
      if (!file || !fs.existsSync(file)) return
      const stat = fs.statSync(file)
      if (!stat.isFile() || stat.size === 0) return
      const key = cacheKey(file, stat)
      if (this.cachedTranscode(file)) return
      void this.enqueue(file, key, false)
    } catch {
      // ignore
    }
  }

  /** Duration in seconds for a local file, probed with ffprobe (cached). */
  async probeDuration(file: string): Promise<number | null> {
    try {
      if (!file || !fs.existsSync(file)) return null
      const stat = fs.statSync(file)
      if (!stat.isFile() || stat.size === 0) return null
      const key = cacheKey(file, stat)
      const cached = this.durationCache.get(key)
      if (cached !== undefined) return cached
      const bin = await this.findFfprobe()
      if (!bin) return null
      const dur = await runFfprobe(bin, file)
      if (dur !== null) this.durationCache.set(key, dur)
      return dur
    } catch {
      return null
    }
  }

  private enqueue(file: string, key: string, high: boolean): Promise<string | null> {
    const existing = this.inflight.get(key)
    if (existing) return existing
    const promise = new Promise<string | null>((resolve) => {
      const item = this.pending.find((i) => i.key === key)
      if (item) {
        item.resolvers.push(resolve)
        if (high) {
          const idx = this.pending.indexOf(item)
          this.pending.splice(idx, 1)
          this.pending.unshift(item)
        }
        return
      }
      const created: QueueItem = { file, key, resolvers: [resolve] }
      if (high) this.pending.unshift(created)
      else this.pending.push(created)
    })
    this.inflight.set(key, promise)
    void promise.finally(() => {
      this.inflight.delete(key)
    })
    void this.pump()
    return promise
  }

  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    while (this.pending.length > 0) {
      const item = this.pending.shift()!
      const out = await this.runTranscode(item.file, item.key)
      for (const resolve of item.resolvers) resolve(out)
      await new Promise((r) => setImmediate(r))
    }
    this.running = false
  }

  private async runTranscode(file: string, key: string): Promise<string | null> {
    try {
      const bin = await this.findFfmpeg()
      if (!bin) {
        getLogger().debug('ffmpeg not found; transcode fallback unavailable')
        return null
      }
      if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })
      const out = path.join(TMP_DIR, `${key}.mp3`)
      await runFfmpeg(bin, file, out)
      if (!fs.existsSync(out) || fs.statSync(out).size <= 0) {
        try {
          fs.unlinkSync(out)
        } catch {
          // ignore
        }
        return null
      }
      this.cache.set(key, out)
      return out
    } catch (err) {
      getLogger().debug(`Transcode failed for ${file}`, err)
      return null
    }
  }

  private async findFfmpeg(): Promise<string | null> {
    if (this.ffmpegBin !== undefined) return this.ffmpegBin
    const candidates: string[] = []

    // Winget-installed ffmpeg (e.g. the one bundled with yt-dlp.FFmpeg).
    const localAppData = process.env.LOCALAPPDATA
    if (localAppData) {
      const base = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages')
      try {
        for (const pkg of fs.readdirSync(base)) {
          const lower = pkg.toLowerCase()
          if (lower.includes('ffmpeg')) {
            const pkgDir = path.join(base, pkg)
            try {
              for (const ver of fs.readdirSync(pkgDir)) {
                const bin = path.join(pkgDir, ver, 'bin', 'ffmpeg.exe')
                if (fs.existsSync(bin)) candidates.push(bin)
              }
            } catch {
              // ignore
            }
          }
        }
      } catch {
        // ignore
      }
    }

    for (const c of candidates) {
      if (await isFfmpeg(c)) {
        this.ffmpegBin = c
        return c
      }
    }
    if (await isFfmpeg('ffmpeg')) {
      this.ffmpegBin = 'ffmpeg'
      return 'ffmpeg'
    }
    this.ffmpegBin = null
    return null
  }

  private async findFfprobe(): Promise<string | null> {
    if (this.ffprobeBin !== undefined) return this.ffprobeBin

    // ffprobe usually sits next to ffmpeg.
    const ffmpeg = await this.findFfmpeg()
    if (ffmpeg && ffmpeg !== 'ffmpeg') {
      const sibling = path.join(path.dirname(ffmpeg), 'ffprobe.exe')
      if (fs.existsSync(sibling) && (await isFfprobe(sibling))) {
        this.ffprobeBin = sibling
        return sibling
      }
    }
    if (await isFfprobe('ffprobe')) {
      this.ffprobeBin = 'ffprobe'
      return 'ffprobe'
    }
    this.ffprobeBin = null
    return null
  }
}

function cacheKey(file: string, stat: fs.Stats): string {
  return createHash('sha1').update(`${file}|${stat.size}|${stat.mtimeMs}`).digest('hex')
}

function isFfmpeg(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(bin, ['-version'], { timeout: 8000, windowsHide: true }, (err) => resolve(!err))
  })
}

function isFfprobe(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(bin, ['-version'], { timeout: 8000, windowsHide: true }, (err) => resolve(!err))
  })
}

function runFfmpeg(bin: string, input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      bin,
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        input,
        '-vn',
        '-acodec',
        'libmp3lame',
        '-b:a',
        '192k',
        '-ar',
        '44100',
        '-ac',
        '2',
        output
      ],
      { windowsHide: true }
    )
    let errOut = ''
    child.stderr.on('data', (d: Buffer) => {
      errOut += String(d)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}: ${errOut.slice(0, 300)}`))
    })
  })
}

function runFfprobe(bin: string, input: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      bin,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        input
      ],
      { timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(null)
          return
        }
        const n = parseFloat(String(stdout).trim())
        resolve(Number.isFinite(n) && n > 0 ? n : null)
      }
    )
  })
}
