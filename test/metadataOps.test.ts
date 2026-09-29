import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import NodeID3 from 'node-id3'
import { Database } from '../src/main/services/database'
import { runMigrations } from '../src/main/services/migrations'
import { LibraryService } from '../src/main/services/library'
import { ArtworkService } from '../src/main/services/artwork'
import { TranscodeService } from '../src/main/services/transcode'
import { MetadataOpsService } from '../src/main/services/metadataOps'
import { initLogger } from '../src/main/services/logger'
import { artistIdFor } from '../src/main/util/identity'

initLogger(os.tmpdir())

describe('editing song metadata', () => {
  let dir = ''
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('keeps the other tags in the file and regroups the song', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oli-meta-'))
    const file = path.join(dir, 'song.mp3')
    fs.writeFileSync(file, Buffer.alloc(4096))
    NodeID3.write({ title: 'Old', artist: 'Band', album: 'Record', genre: 'Rock' }, file)

    const db = new Database({ file: path.join(dir, 'lib.sqlite') })
    await db.init()
    runMigrations(db)
    const artwork = new ArtworkService(db, path.join(dir, 'art'))
    const library = new LibraryService(db, artwork, new TranscodeService())
    const ops = new MetadataOpsService(db, library, artwork)
    db.run(
      `INSERT INTO songs (id, title, artist, artist_id, album, album_id, duration, path, added_at, modified_at)
       VALUES ('s1', 'Old', 'Band', ?, 'Record', 'album:x', 100, ?, 1, 1)`,
      [artistIdFor('Band'), file]
    )

    expect(ops.applySongEdits('s1', { title: 'New', artist: 'Other Band' })).toBe(true)

    const tags = NodeID3.read(file)
    expect(tags.title).toBe('New')
    expect(tags.album).toBe('Record') // write() used to wipe this
    expect(tags.genre).toBe('Rock')
    const row = db.get<{ artist_id: string }>("SELECT artist_id FROM songs WHERE id = 's1'")
    expect(row?.artist_id).toBe(artistIdFor('Other Band'))

    // Clearing a required field falls back instead of failing the edit.
    expect(ops.applySongEdits('s1', { album: '' })).toBe(true)
    expect(db.get<{ album: string }>("SELECT album FROM songs WHERE id = 's1'")?.album).toBe('Unknown Album')
    await db.close()
  })
})
