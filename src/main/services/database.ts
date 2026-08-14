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
    if (bytes && bytes.length > 0) {
      try {
        this.raw = new SQL.Database(bytes)
      } catch (err) {
        log.error('DB failed to open, attempting recovery', err)
        this.raw = new SQL.Database()
      }
    } else {
      this.raw = new SQL.Database()
    }
    this.configure()
    if (!this.checkIntegrity()) {
      log.warn('Integrity check failed - attempting recovery from latest backup')
      const restored = await this.tryRestoreFromBackup()
      if (!restored) {
        log.error('Recovery failed - reinitializing empty database')
        this.raw.close()
        this.raw = new SQL.Database()
        this.configure()
      }
    }
  }

  private configure(): void {
    this.raw?.run('PRAGMA foreign_keys = ON')
    this.raw?.run('PRAGMA busy_timeout = 5000')
  }

  private checkIntegrity(): boolean {
    try {
      const res = this.get<Record<string, string>>('PRAGMA quick_check')
      return Object.values(res ?? {})[0] === 'ok'
    } catch {
      return false
    }
  }

  private async tryRestoreFromBackup(): Promise<boolean> {
    const dir = path.dirname(this.file)
    let backups: string[]
    try {
      backups = fs
        .readdirSync(dir)
        .filter((f) => /^backup-.*\.sqlite$/.test(f))
        .sort()
    } catch {
      return false
    }
    for (let i = backups.length - 1; i >= 0; i--) {
      try {
        const bytes = fs.readFileSync(path.join(dir, backups[i]))
        const SQL = await loadSqlJs()
        const raw = new SQL.Database(bytes)
        if (this.raw) this.raw.close()
        this.raw = raw
        this.configure()
        if (this.checkIntegrity()) return true
        this.raw.close()
      } catch {
        // keep looking
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
      if (this.raw) this.raw.close()
      this.raw = next
      this.configure()
      return this.checkIntegrity()
    } catch (err) {
      getLogger().error('replaceFromBytes failed', err)
      return false
    }
  }
}