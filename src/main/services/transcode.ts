import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { getLogger } from './logger'
import { playablePath } from '../util/longPath'

export const TRANSCODE_TMP_DIR = path.join(os.tmpdir(), 'cyttos-transcode')
const TMP_DIR = TRANSCODE_TMP_DIR

interface QueueItem {
  file: string
  key: string
  resolvers: Array<(value: string | null) => void>
}

/**
 * Fallback decoder: when Chromium cannot play a local file (e.g. some opus
 * files, ape/wavpack/...), transcode it once to MP3 with ffmpeg and play the
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
            if (entry.endsWith('.part') || fs.statSync(p).size <= 0) fs.unlinkSync(p)
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
    return this.lookup(cacheKey(file, stat))
  }

  /**
   * Finished MP3 for a cache key: the in-memory map, or a file written by an
   * earlier session (outputs are only renamed into place once complete, so
   * an existing .mp3 is always whole).
   */
  private lookup(key: string): string | null {
    for (const candidate of [
      this.cache.get(key),
      path.join(TMP_DIR, `${key}.m4a`),
      path.join(TMP_DIR, `${key}.mp3`)
    ]) {
      if (!candidate) continue
      try {
        if (fs.statSync(candidate).size > 0) {
          this.cache.set(key, candidate)
          return candidate
        }
      } catch {
        // not cached
      }
    }
    return null
  }

  /** Returns a path to a playable MP3 for the given file, or null on failure. */
  async transcodeToMp3(file: string): Promise<string | null> {
    try {
      if (!file || !fs.existsSync(file)) return null
      const stat = fs.statSync(file)
      if (!stat.isFile() || stat.size === 0) return null
      const key = cacheKey(file, stat)
      const cached = this.lookup(key)
      if (cached) return cached
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
      // ffmpeg cannot open paths beyond MAX_PATH either.
      const input = await playablePath(file)
      // Write to a temp name and rename when complete: an interrupted run
      // (app closed mid-transcode) must never leave a truncated file that a
      // later session would treat as finished and cut the song short.
      const attempt = async (out: string, remux: boolean): Promise<string | null> => {
        const part = `${out}.part`
        try {
          await runFfmpeg(bin, input, part, remux)
          if (!fs.existsSync(part) || fs.statSync(part).size <= 0) return null
          fs.renameSync(part, out)
          return out
        } catch (err) {
          getLogger().debug(`${remux ? 'Remux' : 'Transcode'} failed for ${file}`, err)
          return null
        } finally {
          try {
            if (fs.existsSync(part)) fs.unlinkSync(part)
          } catch {
            // ignore
          }
        }
      }
      // AAC in an MP4 container that Chromium rejects (typically because of
      // an embedded cover "video" track) only needs its audio copied into a
      // clean file: instant and lossless, unlike an MP3 re-encode.
      const ext = path.extname(file).toLowerCase()
      let result: string | null = null
      if (ext === '.m4a' || ext === '.mp4') {
        result = await attempt(path.join(TMP_DIR, `${key}.m4a`), true)
      }
      if (!result) result = await attempt(path.join(TMP_DIR, `${key}.mp3`), false)
      if (!result) return null
      this.cache.set(key, result)
      return result
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

function runFfmpeg(bin: string, input: string, output: string, remux = false): Promise<void> {
  const codecArgs = remux
    ? ['-vn', '-c:a', 'copy', '-movflags', '+faststart', '-f', 'mp4']
    : ['-vn', '-acodec', 'libmp3lame', '-b:a', '192k', '-ar', '44100', '-ac', '2', '-f', 'mp3']
  return new Promise((resolve, reject) => {
    // The output name ends in .part, so the container is given explicitly.
    const child = spawn(
      bin,
      ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, ...codecArgs, output],
      { windowsHide: true }
    )
    // One worker serves every transcode: a hung ffmpeg (corrupt input,
    // unreachable network share) must not block playback forever.
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // ignore
      }
    }, 10 * 60_000)
    let errOut = ''
    child.stderr.on('data', (d: Buffer) => {
      if (errOut.length < 4000) errOut += String(d)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
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

