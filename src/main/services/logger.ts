import * as fs from 'node:fs'
import * as path from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

interface LogEntry {
  ts: string
  level: LogLevel
  msg: string
  meta?: unknown
}

const MAX_BYTES = 5 * 1024 * 1024
const MAX_FILES = 5
const RING_LENGTH = 200

export class Logger {
  private dir: string
  private level: LogLevel
  private currentFile = ''
  private stream: fs.WriteStream | null = null
  private ring: LogEntry[] = []
  private enabled = true

  constructor(logDir: string, level: LogLevel = 'info') {
    this.level = level
    this.dir = logDir
    try {
      fs.mkdirSync(logDir, { recursive: true })
    } catch {
      this.enabled = false
    }
    this.roll()
  }

  private roll(): void {
    try {
      if (this.stream) {
        this.stream.end()
        this.stream = null
      }
      const files = fs
        .readdirSync(this.dir)
        .filter((f) => f.startsWith('cytto-') && f.endsWith('.log'))
        .sort()
      while (files.length >= MAX_FILES) {
        const oldest = files.shift()
        if (oldest) fs.unlinkSync(path.join(this.dir, oldest))
      }
      const now = new Date()
      this.currentFile = path.join(
        this.dir,
        `cytto-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
          now.getDate()
        ).padStart(2, '0')}-${now.toTimeString().slice(0, 8).replace(/:/g, '')}.log`
      )
      if (!this.enabled) return
      this.stream = fs.createWriteStream(this.currentFile, { flags: 'a' })
    } catch {
      this.enabled = false
    }
  }

    private shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.level]
  }

  private write(level: LogLevel, msg: string, meta?: unknown): void {
    if (!this.shouldLog(level)) return
    const entry: LogEntry = { ts: new Date().toISOString(), level, msg, meta }
    if (this.ring.length >= RING_LENGTH) this.ring.shift()
    this.ring.push(entry)
    let line: string
    try {
      line = JSON.stringify(entry) + '\n'
    } catch {
      line = JSON.stringify({ ts: entry.ts, level, msg: String(msg) }) + '\n'
    }
    if (!this.enabled) return
    try {
      if (this.stream) {
        this.stream.write(line)
        const stat = this.stream.bytesWritten
        if (stat > MAX_BYTES) this.roll()
      }
    } catch {
      this.enabled = false
    }
  }

  debug(msg: string, meta?: unknown): void {
    this.write('debug', msg, meta)
  }
  info(msg: string, meta?: unknown): void {
    this.write('info', msg, meta)
  }
  warn(msg: string, meta?: unknown): void {
    this.write('warn', msg, meta)
  }
  error(msg: string, meta?: unknown): void {
    this.write('error', msg, meta)
  }

  /** Recent in-memory entries, useful for crash reports. */
  recent(limit = 50): LogEntry[] {
    return this.ring.slice(-limit)
  }

  end(): void {
    try {
      this.stream?.end()
    } catch {
      // ignore
    }
  }
}

let _log: Logger | null = null

export function initLogger(logDir: string, level: LogLevel = 'info'): Logger {
  _log = new Logger(logDir, level)
  return _log
}

export function getLogger(): Logger {
  if (!_log) {
    throw new Error('Logger not initialized. Call initLogger first.')
  }
  return _log
}

export function errorOf(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}