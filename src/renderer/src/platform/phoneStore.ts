/** Database side of the phone-music scanner (see phoneLibrary.ts). Kept apart from androidCore.ts so it can be tested with a real database. */
import type { Database } from '@main/services/database'
import type { LibraryQueries } from '@main/services/libraryQueries'
import type { PhoneSongRow, PhoneStore, SongPatch } from './phoneLibrary'

export function createPhoneStore(db: Database, library: LibraryQueries, flush: () => void): PhoneStore {
  const SONG_COLUMNS = `id, library_id, folder_id, title, artist, artist_id, album_artist, album, album_id, genre, composer, year,
         release_date, track_no, disc_no, isrc, rating, duration, bitrate, sample_rate, bit_depth, channels, codec, format,
         file_size, path, replay_gain, replay_gain_album, lyrics, has_embedded_artwork, added_at, modified_at, source`

  // one ? for every column above except `source`, which is always 'local'
  const PLACEHOLDERS = Array.from({ length: 32 }, () => '?').join(', ')

  return {
    ensureLocation(id, path, name) {
      db.run('INSERT OR IGNORE INTO library_locations (id, path, name, added_at) VALUES (?, ?, ?, ?)', [id, path, name, Date.now()])
    },
    removeLocation(id) {
      db.run('DELETE FROM songs WHERE library_id = ?', [id])
      db.run('DELETE FROM library_locations WHERE id = ?', [id])
      library.rebuildAggregates()
      library.notifyChanged()
      flush()
    },
    songsOf(libraryId) {
      return db
        .all<{ id: string; modified_at: number; missing: number; sample_rate: number | null; path: string }>(
          'SELECT id, modified_at, missing, sample_rate, path FROM songs WHERE library_id = ?',
          [libraryId]
        )
        .map((r): PhoneSongRow => ({ id: r.id, modifiedAt: r.modified_at, missing: r.missing === 1, sampleRate: r.sample_rate, path: r.path }))
    },
    upsertTracks(tracks) {
      const tx = db.transaction()
      try {
        for (const t of tracks) {
          // A song that moved keeps its old (now missing) row: give that row's path away so the new one can take it.
          db.run("UPDATE songs SET path = path || '#moved:' || id WHERE path = ? AND id != ?", [t.path, t.id])
          db.run(
            `INSERT INTO songs (${SONG_COLUMNS}) VALUES (${PLACEHOLDERS}, 'local')
             ON CONFLICT(id) DO UPDATE SET
               library_id = excluded.library_id, folder_id = excluded.folder_id, title = excluded.title, artist = excluded.artist,
               artist_id = excluded.artist_id, album_artist = excluded.album_artist, album = excluded.album, album_id = excluded.album_id,
               genre = excluded.genre, composer = excluded.composer, year = excluded.year, release_date = excluded.release_date,
               track_no = excluded.track_no, disc_no = excluded.disc_no, duration = excluded.duration, bitrate = excluded.bitrate,
               sample_rate = NULL, bit_depth = NULL, channels = NULL, codec = excluded.codec, format = excluded.format,
               file_size = excluded.file_size, path = excluded.path, modified_at = excluded.modified_at, missing = 0`,
            [
              t.id, t.libraryId, t.folderId, t.title, t.artist, t.artistId, t.albumArtist, t.album, t.albumId, t.genre, t.composer,
              t.year, t.releaseDate, t.trackNo, t.discNo, t.isrc, t.rating, t.duration, t.bitrate, t.sampleRate, t.bitDepth,
              t.channels, t.codec, t.format, t.fileSize, t.path, t.replayGain, t.replayGainAlbum, t.lyrics,
              t.hasEmbeddedArtwork ? 1 : 0, t.addedAt, t.modifiedAt
            ]
          )
        }
        tx.commit()
      } catch (err) {
        tx.rollback()
        throw err
      }
    },
    markMissing(ids) {
      for (let i = 0; i < ids.length; i += 400) {
        const chunk = ids.slice(i, i + 400)
        db.run(`UPDATE songs SET missing = 1 WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk)
      }
    },
    patchSongs(patches) {
      const columns: Record<keyof SongPatch, string> = {
        sampleRate: 'sample_rate',
        bitDepth: 'bit_depth',
        channels: 'channels',
        codec: 'codec',
        replayGain: 'replay_gain',
        replayGainAlbum: 'replay_gain_album',
        isrc: 'isrc',
        lyrics: 'lyrics',
        discNo: 'disc_no',
        composer: 'composer',
        genre: 'genre'
      }
      const tx = db.transaction()
      try {
        for (const { id, patch } of patches) {
          const sets: string[] = []
          const params: unknown[] = []
          for (const key of Object.keys(patch) as Array<keyof SongPatch>) {
            const value = patch[key]
            if (value === undefined) continue
            // Tags that MediaStore already filled are kept; only empty ones are completed from the file.
            const fillOnly = key === 'composer' || key === 'genre' || key === 'discNo'
            sets.push(fillOnly ? `${columns[key]} = COALESCE(NULLIF(${columns[key]}, ''), ?)` : `${columns[key]} = ?`)
            params.push(value)
          }
          if (sets.length === 0) continue
          params.push(id)
          db.run(`UPDATE songs SET ${sets.join(', ')} WHERE id = ?`, params as never)
        }
        tx.commit()
      } catch (err) {
        tx.rollback()
        throw err
      }
    },
    finish(libraryId) {
      library.rebuildAggregates()
      db.run('UPDATE library_locations SET last_scan_at = ? WHERE id = ?', [Date.now(), libraryId])
      library.notifyChanged()
      flush()
    },
    songLocation(id) {
      const r = db.get<{ path: string; album_id: string | null }>('SELECT path, album_id FROM songs WHERE id = ?', [id])
      return r ? { path: r.path, albumId: r.album_id } : undefined
    }
  }
}
