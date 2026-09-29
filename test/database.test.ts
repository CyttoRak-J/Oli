import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Database } from '../src/main/services/database'
import { initLogger } from '../src/main/services/logger'

initLogger(os.tmpdir())

describe('database safety', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oli-db-'))
    file = path.join(dir, 'library.sqlite')
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  async function makeLibrary(title: string): Promise<Uint8Array> {
    const db = new Database({ file: path.join(dir, `src-${title}.sqlite`) })
    await db.init()
    db.exec('CREATE TABLE songs (id TEXT PRIMARY KEY, title TEXT)')
    db.run('INSERT INTO songs VALUES (?, ?)', ['1', title])
    const bytes = db.exportBytes()
    await db.close()
    return bytes
  }

  it('keeps a damaged database file and recovers from backups/', async () => {
    fs.writeFileSync(file, Buffer.from('this is not a sqlite file at all'.repeat(200)))
    fs.mkdirSync(path.join(dir, 'backups'))
    fs.writeFileSync(
      path.join(dir, 'backups', 'backup-2026-01-01T00-00-00-000Z.sqlite'),
      Buffer.from(await makeLibrary('from-backup'))
    )
    const db = new Database({ file })
    await db.init()
    expect(db.get<{ title: string }>('SELECT title FROM songs')?.title).toBe('from-backup')
    expect(fs.readdirSync(dir).some((f) => f.startsWith('library.sqlite.damaged-'))).toBe(true)
    await db.close()
  })

  it('refuses to restore an invalid file and keeps the live library', async () => {
    const db = new Database({ file })
    await db.init()
    db.exec('CREATE TABLE songs (id TEXT PRIMARY KEY, title TEXT)')
    db.run('INSERT INTO songs VALUES (?, ?)', ['1', 'live'])
    const ok = await db.replaceFromBytes(Buffer.from('garbage'.repeat(100)))
    expect(ok).toBe(false)
    expect(db.get<{ title: string }>('SELECT title FROM songs')?.title).toBe('live')
    const ok2 = await db.replaceFromBytes(await makeLibrary('restored'))
    expect(ok2).toBe(true)
    expect(db.get<{ title: string }>('SELECT title FROM songs')?.title).toBe('restored')
    await db.close()
  })
})
