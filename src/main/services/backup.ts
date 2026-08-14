import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Database } from './database'
import { getLogger } from './logger'

export class BackupService {
  constructor(
    private db: Database,
    private backupsDir: string
  ) {}

  ensureDir(): void {
    try {
      fs.mkdirSync(this.backupsDir, { recursive: true })
    } catch {
      // ignore
    }
  }

  create(): string | null {
    this.ensureDir()
    const bytes = this.db.exportBytes()
    if (bytes.length === 0) return null
    const filename = `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`
    const filePath = path.join(this.backupsDir, filename)
    try {
      fs.writeFileSync(filePath, Buffer.from(bytes))
      this.rotate(8)
      getLogger().info(`Backup created: ${filename}`)
      return filePath
    } catch (err) {
      getLogger().error('Backup creation failed', err)
      return null
    }
  }

  list(): Array<{ path: string; createdAt: number; size: number }> {
    this.ensureDir()
    try {
      return fs
        .readdirSync(this.backupsDir)
        .filter((f) => f.startsWith('backup-') && f.endsWith('.sqlite'))
        .map((f) => {
          const p = path.join(this.backupsDir, f)
          const stat = fs.statSync(p)
          return { path: p, createdAt: stat.mtimeMs, size: stat.size }
        })
        .sort((a, b) => b.createdAt - a.createdAt)
    } catch {
      return []
    }
  }

  /** Replaces the live database with the given backup's bytes. */
  async restore(filePath: string): Promise<boolean> {
    try {
      const bytes = fs.readFileSync(filePath)
      if (bytes.length === 0) return false
      const ok = await this.db.replaceFromBytes(bytes)
      if (ok) getLogger().info(`Restored database from ${filePath}`)
      return ok
    } catch (err) {
      getLogger().error('Backup restore failed', err)
      return false
    }
  }

  private rotate(keep: number): void {
    const files = this.list()
    files.slice(keep).forEach((f) => {
      try {
        fs.unlinkSync(f.path)
      } catch {
        // ignore
      }
    })
  }
}