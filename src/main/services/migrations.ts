import type { Database } from './database'
import { getLogger, errorOf } from './logger'
import { artistIdFor, albumIdFor } from '../util/identity'

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
      // ------------------------------------------------------------------
      // Library
      // ------------------------------------------------------------------
      db.exec(`
        CREATE TABLE IF NOT EXISTS library_locations (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          added_at INTEGER NOT NULL,
          last_scan_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS song_folders (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL UNIQUE,
          library_id TEXT NOT NULL,
          track_count INTEGER NOT NULL DEFAULT 0,
          total_size INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (library_id) REFERENCES library_locations(id) ON DELETE CASCADE
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

        CREATE INDEX IF NOT EXISTS idx_songs_title ON songs(title COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_songs_artist ON songs(artist COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_songs_album ON songs(album COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_songs_artist_id ON songs(artist_id);
        CREATE INDEX IF NOT EXISTS idx_songs_album_id ON songs(album_id);
        CREATE INDEX IF NOT EXISTS idx_songs_genre ON songs(genre);
        CREATE INDEX IF NOT EXISTS idx_songs_year ON songs(year);
        CREATE INDEX IF NOT EXISTS idx_songs_favorite ON songs(favorite);
        CREATE INDEX IF NOT EXISTS idx_songs_play_count ON songs(play_count);
        CREATE INDEX IF NOT EXISTS idx_songs_added_at ON songs(added_at);
        CREATE INDEX IF NOT EXISTS idx_songs_last_played ON songs(last_played_at);
        CREATE INDEX IF NOT EXISTS idx_songs_missing ON songs(missing);
        CREATE INDEX IF NOT EXISTS idx_songs_folder ON songs(folder_id);
        CREATE INDEX IF NOT EXISTS idx_songs_library ON songs(library_id);

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
        CREATE INDEX IF NOT EXISTS idx_albums_title ON albums(title COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_albums_artist ON albums(artist COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_albums_year ON albums(year);

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

        CREATE TABLE IF NOT EXISTS genres (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          track_count INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS merged_artists (
          id TEXT PRIMARY KEY,
          canonical_id TEXT NOT NULL,
          alias TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE (canonical_id, alias)
        );
      `)

      // ------------------------------------------------------------------
      // Playlists
      // ------------------------------------------------------------------
      db.exec(`
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
      `)

      // ------------------------------------------------------------------
      // Queue, history, favorites, search
      // ------------------------------------------------------------------
      db.exec(`
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
          position_seconds INTEGER NOT NULL DEFAULT 0
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

        CREATE TABLE IF NOT EXISTS search_history (
          id TEXT PRIMARY KEY,
          query TEXT NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_search_date ON search_history(created_at);
      `)

      // ------------------------------------------------------------------
      // Cache / providers / downloads / ops
      // ------------------------------------------------------------------
      db.exec(`
        CREATE TABLE IF NOT EXISTS lyrics_cache (
          song_id TEXT PRIMARY KEY,
          source TEXT,
          synced INTEGER NOT NULL DEFAULT 0,
          lyrics TEXT NOT NULL,
          fetched_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS artwork_cache (
          key TEXT PRIMARY KEY,
          media_type TEXT NOT NULL,
          source TEXT NOT NULL,
          stored_path TEXT,
          mtime INTEGER,
          created_at INTEGER NOT NULL,
          last_used INTEGER NOT NULL
        );

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
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS failed_downloads (
          id TEXT PRIMARY KEY,
          url TEXT NOT NULL,
          error TEXT,
          failed_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          level TEXT NOT NULL,
          message TEXT NOT NULL,
          meta TEXT
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

        CREATE TABLE IF NOT EXISTS pinned_items (
          item_type TEXT NOT NULL,
          item_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (item_type, item_id)
        );

        CREATE TABLE IF NOT EXISTS duplicate_groups (
          id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL,
          song_id TEXT NOT NULL,
          reason TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_dup_group ON duplicate_groups(group_id);
      `)

      // ------------------------------------------------------------------
      // Settings / state / migrations
      // ------------------------------------------------------------------
      db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS application_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS version_info (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS migration_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          version INTEGER NOT NULL,
          name TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS _migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        );
      `)

      // ------------------------------------------------------------------
      // Search index (FTS5). Guarded: if FTS5 is unavailable in the WASM
      // build, the table is simply not created and search falls back to LIKE.
      // ------------------------------------------------------------------
      const hasFts5 = db
        .all<{ name: string }>('SELECT compile_options AS name FROM pragma_compile_options')
        .some((r) => r.name === 'ENABLE_FTS5')
      if (hasFts5) {
        db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS songs_fts USING fts5(
            id UNINDEXED,
            title,
            artist,
            album,
            genre,
            composer,
            content='songs'
          );
          CREATE TRIGGER IF NOT EXISTS songs_ai AFTER INSERT ON songs BEGIN
            INSERT INTO songs_fts(rowid, title, artist, album, genre, composer)
            VALUES (new.rowid, new.title, new.artist, new.album, new.genre, new.composer);
          END;
          CREATE TRIGGER IF NOT EXISTS songs_ad AFTER DELETE ON songs BEGIN
            INSERT INTO songs_fts(songs_fts, rowid, title, artist, album, genre, composer)
            VALUES ('delete', old.rowid, old.title, old.artist, old.album, old.genre, old.composer);
          END;
          CREATE TRIGGER IF NOT EXISTS songs_au AFTER UPDATE ON songs BEGIN
            INSERT INTO songs_fts(songs_fts, rowid, title, artist, album, genre, composer)
            VALUES ('delete', old.rowid, old.title, old.artist, old.album, old.genre, old.composer);
            INSERT INTO songs_fts(rowid, title, artist, album, genre, composer)
            VALUES (new.rowid, new.title, new.artist, new.album, new.genre, new.composer);
          END;
        `)
      }
    }
  },
  {
    version: 2,
    name: 'lyrics-index-and-artwork',
    up: (db: Database) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_lyrics_song ON lyrics_cache(song_id);
        CREATE INDEX IF NOT EXISTS idx_artwork_used ON artwork_cache(last_used);
      `)
    }
  },
  {
    version: 3,
    name: 'merged-albums',
    up: (db: Database) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS merged_albums (
          id TEXT PRIMARY KEY,
          canonical_id TEXT NOT NULL,
          alias TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE (canonical_id, alias)
        );
      `)
    }
  },
  {
    version: 4,
    name: 'history-online-metadata',
    up: (db: Database) => {
      db.exec(`
        ALTER TABLE playback_history ADD COLUMN title TEXT;
        ALTER TABLE playback_history ADD COLUMN artist TEXT;
        ALTER TABLE playback_history ADD COLUMN artwork_url TEXT;
      `)
    }
  },
  {
    version: 5,
    name: 'downloads-kind',
    up: (db: Database) => {
      db.exec(`ALTER TABLE downloads ADD COLUMN kind TEXT NOT NULL DEFAULT 'video';`)
    }
  },
  {
    version: 6,
    name: 'yt-file-meta',
    up: (db: Database) => {
      db.exec(`
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
      `)
    }
  },
  {
    version: 7,
    name: 'unify-identity-hashes',
    up: (db: Database) => {
      const aliasTo = (
        table: 'merged_artists' | 'merged_albums'
      ): Map<string, string> => {
        const map = new Map<string, string>()
        for (const row of db.all<{ alias: string; canonical_id: string }>(
          `SELECT alias, canonical_id FROM ${table}`
        )) {
          map.set(row.alias, row.canonical_id)
        }
        return map
      }
      const artistAliases = aliasTo('merged_artists')
      const albumAliases = aliasTo('merged_albums')
      const rows = db.all<{ id: string; artist: string; album_artist: string | null; album: string }>(
        'SELECT id, artist, album_artist, album FROM songs WHERE missing = 0'
      )
      for (const song of rows) {
        const rawArtist = artistIdFor(song.artist)
        const rawAlbum = albumIdFor(song.album_artist ?? song.artist, song.album)
        const artistId = artistAliases.get(rawArtist) ?? rawArtist
        const albumId = albumAliases.get(rawAlbum) ?? rawAlbum
        db.run('UPDATE songs SET artist_id = ?, album_id = ? WHERE id = ?', [
          artistId,
          albumId,
          song.id
        ])
      }
    }
  },
  {
    version: 8,
    name: 'queue-track-json',
    up: (db: Database) => {
      db.exec(`ALTER TABLE queue ADD COLUMN track_json TEXT`)
    }
  }
]

export async function runMigrations(db: Database): Promise<void> {
  const log = getLogger()
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `)
  const applied = new Set(
    db.all<{ version: number }>('SELECT version FROM _migrations').map((r) => r.version)
  )
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue
    const tx = db.transaction()
    try {
      migration.up(db)
      db.run('INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        migration.version,
        migration.name,
        Date.now()
      ])
      db.run('INSERT INTO migration_history (version, name, applied_at) VALUES (?, ?, ?)', [
        migration.version,
        migration.name,
        Date.now()
      ])
      tx.commit()
      log.info(`Migration ${migration.version} applied (${migration.name})`)
    } catch (err) {
      tx.rollback()
      log.error(`Migration ${migration.version} failed: ${errorOf(err)}`)
      throw err
    }
  }
}

export function needsMigration(db: Database): boolean {
  const current = db.get<{ version: number }>(
    'SELECT COALESCE(MAX(version), 0) AS version FROM _migrations'
  )
  return (current?.version ?? 0) < MIGRATIONS.length
}

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version