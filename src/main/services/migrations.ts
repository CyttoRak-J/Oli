import type { Database } from './database'
import { getLogger } from './logger'

/**
 * Database schema migrations. Migration 1 creates the full schema; it matches
 * the tables of databases created by the original app (verified against a
 * real library.sqlite), so it is a no-op on existing databases. Migration 9
 * repairs databases created by an earlier, inaccurate rebuild of this file.
 */

export interface Migration {
  version: number
  name: string
  up: (db: Database) => void
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up: (db: Database) => {
      // Table definitions match the schema of databases created by the
      // original app (the code in this repo reads/writes exactly these
      // columns). CREATE ... IF NOT EXISTS: a no-op on existing databases.
      db.exec(`
        CREATE TABLE IF NOT EXISTS library_locations (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          added_at INTEGER NOT NULL,
          last_scan_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS songs (
          id TEXT PRIMARY KEY,
          library_id TEXT,
          folder_id TEXT,
          title TEXT NOT NULL,
          artist TEXT NOT NULL,
          artist_id TEXT,
          album_artist TEXT,
          album TEXT NOT NULL,
          album_id TEXT,
          genre TEXT,
          composer TEXT,
          year INTEGER,
          release_date TEXT,
          track_no INTEGER,
          disc_no INTEGER,
          isrc TEXT,
          rating INTEGER,
          duration REAL NOT NULL DEFAULT 0,
          bitrate INTEGER,
          sample_rate INTEGER,
          bit_depth INTEGER,
          channels INTEGER,
          codec TEXT,
          format TEXT,
          file_size INTEGER,
          path TEXT NOT NULL UNIQUE,
          content_hash TEXT,
          fast_hash TEXT,
          replay_gain REAL,
          replay_gain_album REAL,
          lyrics TEXT,
          has_embedded_artwork INTEGER NOT NULL DEFAULT 0,
          added_at INTEGER NOT NULL,
          modified_at INTEGER NOT NULL,
          last_played_at INTEGER,
          play_count INTEGER NOT NULL DEFAULT 0,
          missing INTEGER NOT NULL DEFAULT 0,
          favorite INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          source TEXT NOT NULL DEFAULT 'local',
          FOREIGN KEY (library_id) REFERENCES library_locations(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_songs_added_at ON songs(added_at);
        CREATE INDEX IF NOT EXISTS idx_songs_album ON songs(album COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_songs_album_id ON songs(album_id);
        CREATE INDEX IF NOT EXISTS idx_songs_artist ON songs(artist COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_songs_artist_id ON songs(artist_id);
        CREATE INDEX IF NOT EXISTS idx_songs_favorite ON songs(favorite);
        CREATE INDEX IF NOT EXISTS idx_songs_folder ON songs(folder_id);
        CREATE INDEX IF NOT EXISTS idx_songs_genre ON songs(genre);
        CREATE INDEX IF NOT EXISTS idx_songs_last_played ON songs(last_played_at);
        CREATE INDEX IF NOT EXISTS idx_songs_library ON songs(library_id);
        CREATE INDEX IF NOT EXISTS idx_songs_missing ON songs(missing);
        CREATE INDEX IF NOT EXISTS idx_songs_play_count ON songs(play_count);
        CREATE INDEX IF NOT EXISTS idx_songs_title ON songs(title COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_songs_year ON songs(year);

        CREATE TABLE IF NOT EXISTS song_folders (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL UNIQUE,
          library_id TEXT NOT NULL,
          track_count INTEGER NOT NULL DEFAULT 0,
          total_size INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (library_id) REFERENCES library_locations(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS artists (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          sort_name TEXT,
          genre TEXT,
          biography TEXT,
          favorite INTEGER NOT NULL DEFAULT 0,
          track_count INTEGER NOT NULL DEFAULT 0,
          album_count INTEGER NOT NULL DEFAULT 0,
          added_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_artists_name ON artists(name COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_artists_sort ON artists(sort_name COLLATE NOCASE);

        CREATE TABLE IF NOT EXISTS albums (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          artist TEXT NOT NULL,
          year INTEGER,
          genre TEXT,
          track_id TEXT,
          track_count INTEGER NOT NULL DEFAULT 0,
          total_duration REAL NOT NULL DEFAULT 0,
          favorite INTEGER NOT NULL DEFAULT 0,
          added_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_albums_artist ON albums(artist COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_albums_title ON albums(title COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_albums_year ON albums(year);

        CREATE TABLE IF NOT EXISTS genres (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          track_count INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS playlists (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          type TEXT NOT NULL DEFAULT 'manual',
          rules_json TEXT,
          folder_id TEXT,
          position INTEGER NOT NULL DEFAULT 0,
          pinned INTEGER NOT NULL DEFAULT 0,
          favorite INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS playlist_tracks (
          playlist_id TEXT NOT NULL,
          song_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          added_at INTEGER NOT NULL,
          PRIMARY KEY (playlist_id, position),
          FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_plt_song ON playlist_tracks(song_id);

        CREATE TABLE IF NOT EXISTS queue (
          id TEXT PRIMARY KEY,
          song_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          queued_at INTEGER NOT NULL,
          via TEXT
        );

        CREATE TABLE IF NOT EXISTS playback_history (
          id TEXT PRIMARY KEY,
          song_id TEXT NOT NULL,
          played_at INTEGER NOT NULL,
          completed INTEGER NOT NULL DEFAULT 0,
          duration_seconds INTEGER NOT NULL DEFAULT 0,
          position_seconds INTEGER NOT NULL DEFAULT 0,
          title TEXT,
          artist TEXT,
          artwork_url TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_history_played ON playback_history(played_at);

        CREATE TABLE IF NOT EXISTS history_backups (
          id TEXT PRIMARY KEY,
          json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS favorites (
          id TEXT PRIMARY KEY,
          item_type TEXT NOT NULL,
          item_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE (item_type, item_id)
        );
        CREATE INDEX IF NOT EXISTS idx_favorites_type ON favorites(item_type);

        CREATE TABLE IF NOT EXISTS pinned_items (
          item_type TEXT NOT NULL,
          item_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (item_type, item_id)
        );

        CREATE TABLE IF NOT EXISTS statistics (
          key TEXT PRIMARY KEY,
          value REAL NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS recent_activity (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          item_id TEXT,
          at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_recent_at ON recent_activity(at);

        CREATE TABLE IF NOT EXISTS downloads (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          url TEXT NOT NULL,
          dest_path TEXT NOT NULL DEFAULT '',
          state TEXT NOT NULL DEFAULT 'queued',
          progress REAL NOT NULL DEFAULT 0,
          total_bytes INTEGER,
          downloaded_bytes INTEGER NOT NULL DEFAULT 0,
          speed REAL NOT NULL DEFAULT 0,
          eta_seconds INTEGER,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          kind TEXT NOT NULL DEFAULT 'video'
        );

        CREATE TABLE IF NOT EXISTS failed_downloads (
          id TEXT PRIMARY KEY,
          url TEXT NOT NULL,
          error TEXT,
          failed_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS duplicate_groups (
          id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL,
          song_id TEXT NOT NULL,
          reason TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_dup_group ON duplicate_groups(group_id);

        CREATE TABLE IF NOT EXISTS artwork_cache (
          key TEXT PRIMARY KEY,
          media_type TEXT NOT NULL,
          source TEXT NOT NULL,
          stored_path TEXT,
          mtime INTEGER,
          created_at INTEGER NOT NULL,
          last_used INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_artwork_used ON artwork_cache(last_used);

        CREATE TABLE IF NOT EXISTS lyrics_cache (
          song_id TEXT PRIMARY KEY,
          source TEXT,
          synced INTEGER NOT NULL DEFAULT 0,
          lyrics TEXT NOT NULL,
          fetched_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_lyrics_song ON lyrics_cache(song_id);

        CREATE TABLE IF NOT EXISTS metadata_cache (
          key TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          fetched_at INTEGER NOT NULL,
          ttl INTEGER NOT NULL DEFAULT 86400000
        );

        CREATE TABLE IF NOT EXISTS provider_cache (
          key TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          fetched_at INTEGER NOT NULL,
          ttl INTEGER NOT NULL DEFAULT 3600000
        );

        CREATE TABLE IF NOT EXISTS search_history (
          id TEXT PRIMARY KEY,
          query TEXT NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_search_date ON search_history(created_at);

        CREATE TABLE IF NOT EXISTS yt_file_meta (
          path TEXT PRIMARY KEY,
          video_id TEXT NOT NULL,
          yt_title TEXT,
          provider TEXT,
          composer_ok INTEGER NOT NULL DEFAULT 0,
          cover_ok INTEGER NOT NULL DEFAULT 0,
          artist_ok INTEGER NOT NULL DEFAULT 0,
          tagged_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_yt_file_meta_video ON yt_file_meta(video_id);

        CREATE TABLE IF NOT EXISTS merged_artists (
          id TEXT PRIMARY KEY,
          canonical_id TEXT NOT NULL,
          alias TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE (canonical_id, alias)
        );

        CREATE TABLE IF NOT EXISTS merged_albums (
          id TEXT PRIMARY KEY,
          canonical_id TEXT NOT NULL,
          alias TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE (canonical_id, alias)
        );

        CREATE TABLE IF NOT EXISTS application_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `)

      // FTS5 (full-text search) is a compile-time SQLite extension, not
      // guaranteed to be present in every SQLite build — and critically,
      // it is NOT included in the standard prebuilt sql.js npm package this
      // project actually depends on (verified: CREATE VIRTUAL TABLE ... USING
      // fts5 throws "no such module: fts5" against the real dependency).
      // search.ts already correctly detects FTS5 availability at runtime via
      // pragma_compile_options and falls back to a LIKE-based search when
      // it's absent — but that fallback never got a chance to run, because
      // this table creation used to be inside the same exec() as the rest
      // of the schema, so its failure took migration 1 (and the entire app
      // startup) down with it. Isolated into its own try/catch so a missing
      // FTS5 build degrades search quality instead of preventing the app
      // from starting at all.
      try {
        db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS songs_fts USING fts5(
            title, artist, album, genre, composer, content='songs', content_rowid='rowid'
          );
        `)
      } catch (err) {
        getLogger().warn(
          'FTS5 not available in this SQLite build — search will use the LIKE-based fallback (see search.ts)',
          err
        )
      }
    }
  },
  {
    // Documented in the original source material as migration 8. Kept the
    // same version number/name here on the assumption versions 2-7 covered
    // incremental changes already folded into the version-1 schema above
    // (this rebuild has no way to recover what those intermediate steps
    // actually were).
    version: 8,
    name: 'queue-track-json',
    up: (db: Database) => {
      const cols = db.all<{ name: string }>(`PRAGMA table_info(queue)`)
      if (!cols.some((c) => c.name === 'track_json')) {
        db.exec(`ALTER TABLE queue ADD COLUMN track_json TEXT`)
      }
    }
  },
  {
    // An earlier rebuild of this file created several tables with the wrong
    // columns on fresh installs (search history, downloads, merges, YouTube
    // tag tracking), so the queries in search.ts / downloads.ts /
    // library.ts / metaFix.ts failed with "no such column". Bring such
    // databases in line with the real schema. Idempotent: databases that
    // already have the right columns are left untouched.
    version: 9,
    name: 'repair-reconstructed-schema',
    up: (db: Database) => {
      const columns = (table: string): string[] =>
        db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name)

      const dl = columns('downloads')
      if (dl.length > 0 && !dl.includes('kind')) {
        db.exec(`ALTER TABLE downloads ADD COLUMN kind TEXT NOT NULL DEFAULT 'video'`)
      }

      const art = columns('artwork_cache')
      if (art.length > 0 && !art.includes('mtime')) {
        db.exec(`ALTER TABLE artwork_cache ADD COLUMN mtime INTEGER`)
      }

      const sh = columns('search_history')
      if (sh.length > 0 && (!sh.includes('pinned') || !sh.includes('created_at'))) {
        const when = sh.includes('searched_at') ? 'searched_at' : sh.includes('created_at') ? 'created_at' : '0'
        const pinned = sh.includes('pinned') ? 'pinned' : '0'
        db.exec(`
          ALTER TABLE search_history RENAME TO search_history_old;
          CREATE TABLE search_history (
            id TEXT PRIMARY KEY,
            query TEXT NOT NULL,
            pinned INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
          );
          INSERT OR IGNORE INTO search_history (id, query, pinned, created_at)
            SELECT id, query, COALESCE(${pinned}, 0), COALESCE(${when}, 0) FROM search_history_old;
          DROP TABLE search_history_old;
          CREATE INDEX IF NOT EXISTS idx_search_date ON search_history(created_at);
        `)
      }

      for (const table of ['merged_artists', 'merged_albums']) {
        const mc = columns(table)
        if (mc.length > 0 && (!mc.includes('id') || !mc.includes('created_at'))) {
          db.exec(`
            ALTER TABLE ${table} RENAME TO ${table}_old;
            CREATE TABLE ${table} (
              id TEXT PRIMARY KEY,
              canonical_id TEXT NOT NULL,
              alias TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              UNIQUE (canonical_id, alias)
            );
            INSERT OR IGNORE INTO ${table} (id, canonical_id, alias, created_at)
              SELECT 'merge:' || alias, canonical_id, alias, 0 FROM ${table}_old;
            DROP TABLE ${table}_old;
          `)
        }
      }

      const yt = columns('yt_file_meta')
      if (yt.length > 0 && !yt.includes('tagged_at')) {
        db.exec(`
          ALTER TABLE yt_file_meta RENAME TO yt_file_meta_old;
          CREATE TABLE yt_file_meta (
            path TEXT PRIMARY KEY,
            video_id TEXT NOT NULL,
            yt_title TEXT,
            provider TEXT,
            composer_ok INTEGER NOT NULL DEFAULT 0,
            cover_ok INTEGER NOT NULL DEFAULT 0,
            artist_ok INTEGER NOT NULL DEFAULT 0,
            tagged_at INTEGER NOT NULL DEFAULT 0
          );
          INSERT OR IGNORE INTO yt_file_meta (path, video_id)
            SELECT path, video_id FROM yt_file_meta_old WHERE path IS NOT NULL AND video_id IS NOT NULL;
          DROP TABLE yt_file_meta_old;
          CREATE INDEX IF NOT EXISTS idx_yt_file_meta_video ON yt_file_meta(video_id);
        `)
      }
    }
  }
]

export function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `)
  const applied = new Set(
    db.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version)
  )
  for (const migration of MIGRATIONS.sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) continue
    try {
      migration.up(db)
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        migration.version,
        migration.name,
        Date.now()
      ])
      getLogger().info(`Migration ${migration.version} (${migration.name}) applied`)
    } catch (err) {
      getLogger().error(`Migration ${migration.version} (${migration.name}) failed`, err)
      throw err
    }
  }
}
