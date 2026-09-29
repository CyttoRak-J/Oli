import * as fs from 'node:fs'
import * as path from 'node:path'
import { EventEmitter } from 'node:events'
import initSqlJs, {
  type BindParams,
  type Database as SqlJsDatabase,
  type SqlJsStatic
} from 'sql.js'
import { getLogger } from './logger'

export interface DatabaseOptions {
  file: string
}

type Params = unknown[] | Record<string, unknown>

interface Transaction {
  commit: () => void
  rollback: () => void
}

let sqlJsPromise: Promise<SqlJsStatic> | null = null

function rawWasmPath(): string {
  try {
    const p = require.resolve('sql.js/dist/sql-wasm.wasm')
    if (typeof p === 'string') return p
  } catch {
    // fall through
  }
  return path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
}

export async function loadSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs({
      locateFile: () => rawWasmPath()
    })
  }
  return sqlJsPromise
}

/**
 * SQLite database backed by sql.js (SQLite compiled to WebAssembly).
 *
 * Rationale (documented deviation from the original stack brief): better-sqlite3 is a
 * native module requiring Visual Studio Build Tools on Windows. Using the WASM build of
 * SQLite guarantees that `npm install` and `npm run build:win` succeed on any machine
 * without a compiler toolchain. The API mirrors better-sqlite3's sync surface, so the
 * implementation can be swapped without touching callers.
 */
export class Database extends EventEmitter {
  private raw: SqlJsDatabase | null = null
  private dirty = false
  private persistTimer: NodeJS.Timeout | null = null
  private periodicTimer: NodeJS.Timeout | null = null
  private readonly persistDelayMs = 4000
  private readonly periodicMs = 60_000
  private file: string

  constructor(opts: DatabaseOptions) {
    super()
    this.file = opts.file
  }

  async init(): Promise<void> {
    const log = getLogger()
    const SQL = await loadSqlJs()
    let bytes: Uint8Array | null = null
    if (fs.existsSync(this.file)) {
      try {
        bytes = fs.readFileSync(this.file)
      } catch (err) {
        log.warn('DB file unreadable, starting fresh', err)
      }
    }
    let healthy = true
    if (bytes && bytes.length > 0) {
      try {
        this.raw = new SQL.Database(bytes)
        this.configure()
        healthy = this.checkIntegrity()
      } catch (err) {
        log.error('DB failed to open, attempting recovery', err)
        healthy = false
      }
    } else {
      this.raw = new SQL.Database()
      this.configure()
    }
    if (!healthy) {
      // Keep the damaged file: the next flush would otherwise overwrite the
      // only copy of the library with whatever we end up starting with.
      this.preserveDamagedFile()
      log.warn('Integrity check failed - attempting recovery from latest backup')
      const restored = await this.tryRestoreFromBackup()
      if (restored) {
        this.markDirty()
      } else {
        log.error('Recovery failed - reinitializing empty database')
        this.closeRaw()
        this.raw = new SQL.Database()
        this.configure()
      }
    }
  }

  /** Copy an unreadable/corrupt database file aside before it can be overwritten. */
  private preserveDamagedFile(): void {
    try {
      if (!fs.existsSync(this.file)) return
      const aside = `${this.file}.damaged-${new Date().toISOString().replace(/[:.]/g, '-')}`
      fs.copyFileSync(this.file, aside)
      getLogger().warn(`Damaged database preserved as ${aside}`)
    } catch (err) {
      getLogger().error('Could not preserve damaged database file', err)
    }
  }

  private closeRaw(): void {
    try {
      this.raw?.close()
    } catch {
      // already closed
    }
    this.raw = null
  }

  private configure(): void {
    this.raw?.run('PRAGMA foreign_keys = ON')
    this.raw?.run('PRAGMA busy_timeout = 5000')
  }

  private checkIntegrity(): boolean {
    try {
      const res = this.get<Record<string, string>>('PRAGMA quick_check')
      return Object.values(res ?? {})[0] === 'ok'
    } catch (err) {
      getLogger().warn('Database integrity check failed', err)
      return false
    }
  }

  private async tryRestoreFromBackup(): Promise<boolean> {
    // BackupService writes to <userData>/backups; older builds wrote next to
    // the database. Look in both (this used to check only the latter, so
    // automatic recovery never found a single backup).
    const base = path.dirname(this.file)
    const backups: string[] = []
    for (const dir of [path.join(base, 'backups'), base]) {
      try {
        for (const f of fs.readdirSync(dir)) {
          if (/^backup-.*\.sqlite$/.test(f)) backups.push(path.join(dir, f))
        }
      } catch {
        // directory missing
      }
    }
    // Names embed an ISO timestamp: sorting by file name sorts by age.
    backups.sort((a, b) => path.basename(a).localeCompare(path.basename(b)))
    for (let i = backups.length - 1; i >= 0; i--) {
      try {
        const bytes = fs.readFileSync(backups[i])
        const SQL = await loadSqlJs()
        const candidate = new SQL.Database(bytes)
        if (!isHealthy(candidate)) {
          candidate.close()
          continue
        }
        this.closeRaw()
        this.raw = candidate
        this.configure()
        getLogger().info(`Database recovered from backup ${backups[i]}`)
        return true
      } catch (err) {
        getLogger().warn(`Backup ${backups[i]} failed to restore, trying an older one`, err)
      }
    }
    return false
  }

  get ready(): boolean {
    return this.raw !== null
  }

  run(sql: string, params?: Params): number {
    if (!this.raw) throw new Error('Database not initialized')
    this.markDirty()
    this.raw.run(sql, params as BindParams)
    try {
      return this.raw.getRowsModified()
    } catch {
      return 0
    }
  }

  get<T = Record<string, unknown>>(sql: string, params?: Params): T | undefined {
    const statement = this.raw!.prepare(sql)
    try {
      statement.bind(params as BindParams)
      if (statement.step()) {
        return statement.getAsObject() as T
      }
      return undefined
    } finally {
      statement.free()
    }
  }

  all<T = Record<string, unknown>>(sql: string, params?: Params): T[] {
    const statement = this.raw!.prepare(sql)
    try {
      statement.bind(params as BindParams)
      const rows: T[] = []
      while (statement.step()) {
        rows.push(statement.getAsObject() as T)
      }
      return rows
    } finally {
      statement.free()
    }
  }

  exec(sql: string): void {
    if (!this.raw) throw new Error('Database not initialized')
    this.markDirty()
    this.raw.exec(sql)
  }

  transaction(): Transaction {
    this.raw!.exec('BEGIN')
    let done = false
    return {
      commit: (): void => {
        if (done) return
        done = true
        this.markDirty()
        this.raw!.exec('COMMIT')
      },
      rollback: (): void => {
        if (done) return
        done = true
        this.raw!.exec('ROLLBACK')
      }
    }
  }

  count(sql: string, params?: Params): number {
    const row = this.get<{ n: number }>(`SELECT COUNT(*) AS n FROM (${sql})`, params)
    return Number(row?.n ?? 0)
  }

  /** Export the full database as bytes (used for backups and library export). */
  exportBytes(): Uint8Array {
    return this.raw!.export()
  }

  flushToDisk(): number {
    if (!this.raw) return 0
    let bytes: Uint8Array
    try {
      bytes = this.raw.export()
    } catch (err) {
      this.onPersistError(err)
      return 0
    }
    if (bytes.length === 0) return 0
    const tmp = `${this.file}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(tmp, Buffer.from(bytes))
      fs.renameSync(tmp, this.file)
      this.dirty = false
      return bytes.length
    } catch (err) {
      try {
        fs.unlinkSync(tmp)
      } catch {
        // ignore
      }
      this.onPersistError(err)
      return 0
    }
  }

  private onPersistError(err: unknown): void {
    getLogger().error('Database persist failed', err)
    this.emit('persist:error', err)
  }

  private markDirty(): void {
    this.dirty = true
    if (this.suspended) return
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.flushToDisk()
    }, this.persistDelayMs)
    if (!this.periodicTimer) {
      this.periodicTimer = setInterval(() => {
        if (this.dirty) this.flushToDisk()
        this.optimize()
      }, this.periodicMs)
      this.periodicTimer.unref?.()
    }
  }

  private suspended = false

  /**
   * Bulk operations (library scans) can defer disk persistence to avoid a full
   * DB serialization on every batch write.
   */
  suspendPersistence(): void {
    this.suspended = true
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
  }

  resumePersistence(): void {
    this.suspended = false
    if (this.dirty) this.flushToDisk()
  }

  get isDirty(): boolean {
    return this.dirty
  }

  optimize(): void {
    if (!this.raw) return
    try {
      this.raw.exec('PRAGMA optimize')
    } catch {
      // ignore
    }
  }

  async close(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    if (this.periodicTimer) clearInterval(this.periodicTimer)
    this.flushToDisk()
    try {
      this.raw?.close()
    } catch {
      // ignore
    }
    this.raw = null
  }

  /** Replace the live database with bytes from a backup. */
  async replaceFromBytes(bytes: Uint8Array): Promise<boolean> {
    const SQL = await loadSqlJs()
    try {
      const next = new SQL.Database(bytes)
      // Validate BEFORE swapping: a corrupt or unrelated .sqlite file used to
      // replace the live library first and fail the check afterwards, and
      // the next flush then overwrote the user's library with it.
      if (!isHealthy(next) || !hasTable(next, 'songs')) {
        next.close()
        getLogger().warn('Refusing to restore: file is not a valid Oli library')
        return false
      }
      this.closeRaw()
      this.raw = next
      this.configure()
      this.markDirty()
      return true
    } catch (err) {
      getLogger().error('replaceFromBytes failed', err)
      return false
    }
  }
}

function isHealthy(db: SqlJsDatabase): boolean {
  try {
    const res = db.exec('PRAGMA quick_check')
    return res[0]?.values?.[0]?.[0] === 'ok'
  } catch {
    return false
  }
}

function hasTable(db: SqlJsDatabase, name: string): boolean {
  try {
    const res = db.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${name}'`)
    return (res[0]?.values?.length ?? 0) > 0
  } catch {
    return false
  }
}
