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

// Real end-to-end test against an actual sql.js database (not mocked), to
// verify the new radio-mode query (same-artist, then same-genre, excluding
// already-played tracks) behaves correctly against the real schema.

function seedSong(db: Database, s: {
  id: string; title: string; artist: string; artistId: string; genre: string
  favorite?: number; playCount?: number
}): void {
  db.run(
    `INSERT INTO songs (id, title, artist, artist_id, genre, duration, path, added_at, modified_at, favorite, play_count, missing, album)
     VALUES (?, ?, ?, ?, ?, 200, ?, 1000, 1000, ?, ?, 0, '')`,
    [s.id, s.title, s.artist, s.artistId, s.genre, `/music/${s.id}.mp3`, s.favorite ?? 0, s.playCount ?? 0]
  )
}

describe('getSimilarTracks (radio mode)', () => {
  let db: Database
  let library: LibraryService
  let tmpFile: string

  beforeEach(async () => {
    tmpFile = path.join(os.tmpdir(), `oli-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`)
    db = new Database({ file: tmpFile })
    await db.init()
    runMigrations(db)
    const artworkDir = path.join(os.tmpdir(), `oli-test-artwork-${Date.now()}`)
    const artwork = new ArtworkService(db, artworkDir)
    const transcode = new TranscodeService()
    library = new LibraryService(db, artwork, transcode)
  })

  afterEach(async () => {
    await db.close()
    try {
      fs.unlinkSync(tmpFile)
    } catch {
      /* ignore */
    }
  })

  it('prioritizes same-artist tracks over same-genre tracks', () => {
    seedSong(db, { id: 'seed', title: 'Seed Song', artist: 'Artist A', artistId: 'a1', genre: 'Rock' })
    seedSong(db, { id: 's2', title: 'Song 2', artist: 'Artist A', artistId: 'a1', genre: 'Rock' })
    seedSong(db, { id: 's3', title: 'Song 3', artist: 'Artist B', artistId: 'b1', genre: 'Rock' })

    const results = library.getSimilarTracks('seed', [], 10)
    expect(results.map((t) => t.id)).toContain('s2')
    expect(results.map((t) => t.id)).toContain('s3')
    // same-artist result should come before same-genre-only result
    expect(results.findIndex((t) => t.id === 's2')).toBeLessThan(results.findIndex((t) => t.id === 's3'))
  })

  it('excludes the seed track and explicitly excluded ids', () => {
    seedSong(db, { id: 'seed', title: 'Seed Song', artist: 'Artist A', artistId: 'a1', genre: 'Rock' })
    seedSong(db, { id: 's2', title: 'Song 2', artist: 'Artist A', artistId: 'a1', genre: 'Rock' })

    const results = library.getSimilarTracks('seed', ['s2'], 10)
    expect(results.map((t) => t.id)).not.toContain('seed')
    expect(results.map((t) => t.id)).not.toContain('s2')
  })

  it('respects the limit', () => {
    seedSong(db, { id: 'seed', title: 'Seed', artist: 'Artist A', artistId: 'a1', genre: 'Rock' })
    for (let i = 0; i < 20; i++) {
      seedSong(db, { id: `s${i}`, title: `Song ${i}`, artist: 'Artist A', artistId: 'a1', genre: 'Rock' })
    }
    const results = library.getSimilarTracks('seed', [], 5)
    expect(results.length).toBe(5)
  })

  it('returns an empty array for a nonexistent seed track', () => {
    expect(library.getSimilarTracks('does-not-exist', [], 10)).toEqual([])
  })

  it('returns an empty array when nothing matches artist or genre', () => {
    seedSong(db, { id: 'seed', title: 'Seed', artist: 'Lonely Artist', artistId: 'lonely', genre: 'Obscure' })
    expect(library.getSimilarTracks('seed', [], 10)).toEqual([])
  })
})
