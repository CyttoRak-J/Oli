import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Database } from '../src/main/services/database'
import { runMigrations } from '../src/main/services/migrations'
import { initLogger } from '../src/main/services/logger'

initLogger(os.tmpdir())

const files: string[] = []
async function openDb(): Promise<Database> {
  const file = path.join(os.tmpdir(), `oli-mig-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`)
  files.push(file)
  const db = new Database({ file })
  await db.init()
  return db
}
const columns = (db: Database, table: string): string[] =>
  db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name)

afterEach(() => {
  for (const f of files.splice(0)) {
    try {
      fs.unlinkSync(f)
    } catch {
      /* ignore */
    }
  }
})

describe('migrations', () => {
  it('fresh databases get the columns the services query', async () => {
    const db = await openDb()
    runMigrations(db)
    expect(columns(db, 'search_history')).toEqual(expect.arrayContaining(['pinned', 'created_at']))
    expect(columns(db, 'downloads')).toContain('kind')
    expect(columns(db, 'artwork_cache')).toContain('mtime')
    expect(columns(db, 'merged_albums')).toEqual(expect.arrayContaining(['id', 'created_at']))
    expect(columns(db, 'yt_file_meta')).toEqual(expect.arrayContaining(['yt_title', 'tagged_at']))
    await db.close()
  })

  it('repairs databases created by the old reconstructed schema', async () => {
    const db = await openDb()
    // What the previous migrations.ts produced for these tables.
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);
      INSERT INTO schema_migrations VALUES (1, 'initial-schema', 0), (8, 'queue-track-json', 0);
      CREATE TABLE search_history (id TEXT PRIMARY KEY, query TEXT NOT NULL, searched_at INTEGER NOT NULL);
      INSERT INTO search_history VALUES ('h1', 'beatles', 123);
      CREATE TABLE downloads (id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL, dest_path TEXT,
        state TEXT NOT NULL DEFAULT 'queued', progress REAL NOT NULL DEFAULT 0, total_bytes INTEGER,
        downloaded_bytes INTEGER NOT NULL DEFAULT 0, speed REAL NOT NULL DEFAULT 0, eta_seconds INTEGER,
        error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE artwork_cache (key TEXT PRIMARY KEY, media_type TEXT, source TEXT, stored_path TEXT,
        created_at INTEGER NOT NULL, last_used INTEGER NOT NULL);
      CREATE TABLE merged_albums (alias TEXT PRIMARY KEY, canonical_id TEXT NOT NULL);
      INSERT INTO merged_albums VALUES ('alb:x', 'alb:y');
      CREATE TABLE merged_artists (alias TEXT PRIMARY KEY, canonical_id TEXT NOT NULL);
      CREATE TABLE yt_file_meta (video_id TEXT PRIMARY KEY, path TEXT, fetched_at INTEGER NOT NULL);
      INSERT INTO yt_file_meta VALUES ('vid1', 'C:\\music\\a.m4a', 1);
    `)
    runMigrations(db)

    const h = db.get<{ query: string; pinned: number; created_at: number }>('SELECT * FROM search_history')
    expect(h).toMatchObject({ query: 'beatles', pinned: 0, created_at: 123 })
    // The statements that used to fail now work.
    db.run('INSERT INTO search_history (id, query, pinned, created_at) VALUES (?, ?, 0, ?)', ['h2', 'q', 1])
    db.run(
      `INSERT INTO downloads (id, title, url, dest_path, state, kind, created_at, updated_at)
       VALUES ('d1', 't', 'u', '', 'queued', 'song', 1, 1)`
    )
    db.run(
      'INSERT OR IGNORE INTO merged_albums (id, canonical_id, alias, created_at) VALUES (?, ?, ?, ?)',
      ['m2', 'alb:y', 'alb:z', 1]
    )
    expect(db.all('SELECT alias FROM merged_albums')).toHaveLength(2)
    expect(db.get<{ video_id: string }>('SELECT video_id FROM yt_file_meta')?.video_id).toBe('vid1')
    expect(columns(db, 'artwork_cache')).toContain('mtime')
    await db.close()
  })

  it('is a no-op when run twice', async () => {
    const db = await openDb()
    runMigrations(db)
    runMigrations(db)
    expect(columns(db, 'search_history')).toContain('pinned')
    await db.close()
  })
})
