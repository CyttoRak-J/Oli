/** Phone-app replacement for services/logger.ts (same exports; writes to the web view console, which Android logcat shows). */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogEntry {
  ts: string
  level: LogLevel
  msg: string
  meta?: unknown
}

const RING_LENGTH = 200

export class Logger {
  private ring: LogEntry[] = []

  private write(level: LogLevel, msg: string, meta?: unknown): void {
    const entry: LogEntry = { ts: new Date().toISOString(), level, msg, meta }
    this.ring.push(entry)
    if (this.ring.length > RING_LENGTH) this.ring.shift()
    const fn = level === 'debug' ? console.debug : level === 'info' ? console.info : level === 'warn' ? console.warn : console.error
    fn(`[oli:${level}] ${msg}`, meta ?? '')
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
  recent(limit = 50): LogEntry[] {
    return this.ring.slice(-limit)
  }
  end(): void {
    // nothing to close
  }
}

let instance: Logger | null = null

export function initLogger(_dir?: string, _level?: LogLevel): Logger {
  instance = new Logger()
  return instance
}

export function getLogger(): Logger {
  if (!instance) instance = new Logger()
  return instance
}

export function errorOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
