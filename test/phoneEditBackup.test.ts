import { beforeEach, describe, expect, it } from 'vitest'
import * as os from 'node:os'
import { Database } from '../src/main/services/database'
import { runMigrations } from '../src/main/services/migrations'
import { LibraryQueries } from '../src/main/services/libraryQueries'
import { initLogger } from '../src/main/services/logger'
import { albumIdFor, artistIdFor } from '../src/main/util/identity'
import { applySongEdits } from '../src/renderer/src/platform/songEdits'
import { PhoneBackup, KEEP_BACKUPS, base64ToBytes, bytesToBase64, type BackupStorage } from '../src/renderer/src/platform/phoneBackup'

initLogger(os.tmpdir())

async function newDb(): Promise<{ db: Database; library: LibraryQueries }> {
  const db = new Database({ file: `${os.tmpdir()}/oli-edit-${Date.now()}-${Math.random()}.sqlite` })
  await db.init()
  runMigrations(db)
  return { db, library: new LibraryQueries(db) }
}

function addSong(db: Database, id: string, path: string, extra: Record<string, unknown> = {}): void {
  db.run(
    `INSERT INTO songs (id, title, artist, artist_id, album_artist, album, album_id, duration, path, added_at, modified_at, favorite, play_count)
     VALUES (?, 'Old title', 'Old artist', ?, '', 'Old album', ?, 100, ?, 1, 1, ?, ?)`,
    [id, artistIdFor('Old artist'), albumIdFor('', 'Old album'), path, extra.favorite ?? 0, extra.playCount ?? 0]
  )
}

describe('editing tags on the phone', () => {
  let db: Database
  let library: LibraryQueries
  beforeEach(async () => {
    ;({ db, library } = await newDb())
  })

  it('updates the song and regroups artist and album', async () => {
    addSong(db, 's1', 'content://media/external/audio/media/5')
    const ok = await applySongEdits(db, library, 's1', { title: 'New title', artist: 'New artist', album: 'New album', albumArtist: 'Boss', year: 1999, trackNo: 4, genre: 'Jazz' })
    expect(ok).toBe(true)
    const row = db.get<Record<string, unknown>>("SELECT * FROM songs WHERE id = 's1'")!
    expect(row).toMatchObject({ title: 'New title', artist: 'New artist', album: 'New album', album_artist: 'Boss', year: 1999, track_no: 4, genre: 'Jazz' })
    expect(row.artist_id).toBe(artistIdFor('New artist'))
    expect(row.album_id).toBe(albumIdFor('Boss', 'New album'))
    expect(db.count('SELECT id FROM artists')).toBeGreaterThan(0)
  })

  it('clearing a required field falls back to a placeholder; a missing song fails', async () => {
    addSong(db, 's1', 'file:///storage/emulated/0/Android/data/com.cyttos.oli/files/Oli/A/My%20Song.flac')
    expect(await applySongEdits(db, library, 's1', { title: '', artist: '  ', album: null, genre: '' })).toBe(true)
    const row = db.get<Record<string, unknown>>("SELECT title, artist, album, genre FROM songs WHERE id = 's1'")!
    expect(row).toEqual({ title: 'My Song', artist: 'Unknown Artist', album: 'Unknown Album', genre: null })
    expect(await applySongEdits(db, library, 'nope', { title: 'x' })).toBe(false)
  })

  it('keeps favorites and play counts', async () => {
    addSong(db, 's1', 'content://x/1', { favorite: 1, playCount: 12 })
    await applySongEdits(db, library, 's1', { title: 'Renamed' })
    expect(db.get<{ favorite: number; play_count: number }>("SELECT favorite, play_count FROM songs WHERE id = 's1'")).toEqual({ favorite: 1, play_count: 12 })
  })

  it("writes the file's tags only for Oli's own downloaded files", async () => {
    addSong(db, 'own', 'file:///storage/emulated/0/Android/data/com.cyttos.oli/files/Oli/A/x.flac')
    addSong(db, 'ms', 'content://media/external/audio/media/9')
    const written: Array<{ path: string; tags: Record<string, unknown> }> = []
    const writer = async (path: string, tags: Record<string, unknown>): Promise<boolean> => {
      written.push({ path, tags })
      return true
    }
    await applySongEdits(db, library, 'own', { title: 'T', artist: 'A', year: 2001, trackNo: 3, rating: 5 }, writer)
    await applySongEdits(db, library, 'ms', { title: 'T2' }, writer)
    expect(written).toHaveLength(1)
    expect(written[0].path).toContain('/Oli/A/x.flac')
    expect(written[0].tags).toEqual({ title: 'T', artist: 'A', year: 2001, trackNo: 3 })
    // the library edit is kept even when the file write throws
    const failing = async (): Promise<boolean> => {
      throw new Error('disk full')
    }
    expect(await applySongEdits(db, library, 'own', { title: 'Still saved' }, failing)).toBe(true)
    expect(db.get<{ title: string }>("SELECT title FROM songs WHERE id = 'own'")!.title).toBe('Still saved')
  })
})

describe('phone backup', () => {
  function memoryStorage(): BackupStorage & { files: Map<string, { bytes: Uint8Array; t: number }> } {
    const files = new Map<string, { bytes: Uint8Array; t: number }>()
    let t = 1000
    return {
      files,
      list: async () => [...files].map(([name, f]) => ({ name, createdAt: f.t, size: f.bytes.length })),
      write: async (name, bytes) => {
        files.set(name, { bytes, t: ++t })
      },
      read: async (name) => {
        const f = files.get(name)
        if (!f) throw new Error('missing')
        return f.bytes
      },
      remove: async (name) => {
        files.delete(name)
      }
    }
  }

  it('creates backups, keeps the newest 8, and restores a library exactly', async () => {
    const { db } = await newDb()
    addSong(db, 'a', 'content://x/1')
    addSong(db, 'b', 'content://x/2')
    const storage = memoryStorage()
    let restored = 0
    let n = 0
    const backup = new PhoneBackup(db, storage, () => restored++, () => new Date(2026, 0, 1, 0, 0, ++n))
    for (let i = 0; i < 11; i++) await backup.create()
    const list = await backup.list()
    expect(list).toHaveLength(KEEP_BACKUPS)
    expect(list[0].createdAt).toBeGreaterThan(list[1].createdAt)
    expect(list.every((f) => f.name.startsWith('backup-') && f.name.endsWith('.sqlite'))).toBe(true)

    db.run("DELETE FROM songs WHERE id = 'a'")
    expect(db.count('SELECT id FROM songs')).toBe(1)
    expect(await backup.restoreNamed(list[0].name)).toBe(true)
    expect(restored).toBe(1)
    expect(db.count('SELECT id FROM songs')).toBe(2)
  })

  it('refuses a file that is not an Oli library and leaves the library untouched', async () => {
    const { db } = await newDb()
    addSong(db, 'a', 'content://x/1')
    let restored = 0
    const backup = new PhoneBackup(db, memoryStorage(), () => restored++)
    expect(await backup.restoreBytes(new TextEncoder().encode('this is not a database at all'))).toBe(false)
    expect(await backup.restoreBytes(new Uint8Array())).toBe(false)
    expect(restored).toBe(0)
    expect(db.count('SELECT id FROM songs')).toBe(1)
  })

  it('restores a backup made by another database (export / import between devices)', async () => {
    const { db: other } = await newDb()
    addSong(other, 'x1', 'content://y/1')
    addSong(other, 'x2', 'content://y/2')
    addSong(other, 'x3', 'content://y/3')
    const bytes = new PhoneBackup(other, memoryStorage(), () => undefined).snapshot()
    const { db } = await newDb()
    addSong(db, 'a', 'content://x/1')
    expect(await new PhoneBackup(db, memoryStorage(), () => undefined).restoreBytes(bytes)).toBe(true)
    expect(db.count('SELECT id FROM songs')).toBe(3)
  })

  it('base64 helpers round-trip big buffers', () => {
    const big = new Uint8Array(300_000).map((_, i) => (i * 7) % 256)
    expect(base64ToBytes(bytesToBase64(big))).toEqual(big)
  })
})
