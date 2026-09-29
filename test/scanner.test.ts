import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Database } from '../src/main/services/database'
import { runMigrations } from '../src/main/services/migrations'
import { LibraryService } from '../src/main/services/library'
import { ArtworkService } from '../src/main/services/artwork'
import { TranscodeService } from '../src/main/services/transcode'
import { initLogger } from '../src/main/services/logger'

initLogger(os.tmpdir())

describe('scanning a single library folder', () => {
  let db: Database
  let library: LibraryService
  let root: string

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oli-scan-'))
    db = new Database({ file: path.join(root, 'lib.sqlite') })
    await db.init()
    runMigrations(db)
    const artwork = new ArtworkService(db, path.join(root, 'art'))
    library = new LibraryService(db, artwork, new TranscodeService())
  })

  afterEach(async () => {
    await db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('does not mark songs of other folders as missing', async () => {
    const dirA = path.join(root, 'A')
    const dirB = path.join(root, 'B')
    fs.mkdirSync(dirA)
    fs.mkdirSync(dirB)
    const songA = path.join(dirA, 'a.mp3')
    fs.writeFileSync(songA, 'not really audio')
    db.run('INSERT INTO library_locations (id, path, name, added_at) VALUES (?, ?, ?, ?)', ['libA', dirA, 'A', 1])
    db.run('INSERT INTO library_locations (id, path, name, added_at) VALUES (?, ?, ?, ?)', ['libB', dirB, 'B', 1])
    db.run(
      `INSERT INTO songs (id, library_id, title, artist, album, duration, path, added_at, modified_at, missing)
       VALUES ('songA', 'libA', 'a', 'x', '', 100, ?, 1, 1, 0)`,
      [songA]
    )

    await library.scanLibrary('libB')

    const row = db.get<{ missing: number }>("SELECT missing FROM songs WHERE id = 'songA'")
    expect(row?.missing).toBe(0)
  })
})
