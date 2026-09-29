/**
 * Editing a song's tags on the phone. The library database is always updated (same rules as the PC app: required fields
 * fall back to the scanner's placeholders, artist / album grouping is recomputed). If the song is one Oli downloaded
 * (a file in the app's own folder) the tags are also written into the FLAC / MP3 file; songs from the phone's music
 * library (owned by Android's media store) keep the edit inside Oli only, like non-MP3 files on the PC.
 */
import type { Database } from '@main/services/database'
import type { LibraryQueries } from '@main/services/libraryQueries'
import { albumIdFor, artistIdFor } from '@main/util/identity'
import type { DownloadTags } from './downloadQueue'

export interface TrackEdit {
  title?: string | null
  artist?: string | null
  albumArtist?: string | null
  album?: string | null
  genre?: string | null
  composer?: string | null
  year?: number | null
  trackNo?: number | null
  discNo?: number | null
  rating?: number | null
  lyrics?: string | null
}

/** Writes tags into a file; resolves true when they were written. */
export type FileTagWriter = (path: string, tags: DownloadTags) => Promise<boolean>

function derivedIds(db: Database, artist: string, albumArtist: string, album: string): { artistId: string; albumId: string } {
  const artistId = artistIdFor(artist)
  const albumId = albumIdFor(albumArtist, album)
  const a = db.get<{ canonical_id: string }>('SELECT canonical_id FROM merged_artists WHERE alias = ?', [artistId])
  const b = db.get<{ canonical_id: string }>('SELECT canonical_id FROM merged_albums WHERE alias = ?', [albumId])
  return { artistId: a?.canonical_id ?? artistId, albumId: b?.canonical_id ?? albumId }
}

/** "Song name" from a file path / URI (used when a required title is cleared). */
function stemOf(path: string): string {
  let last = path.split(/[\\/]/).pop() ?? ''
  try {
    last = decodeURIComponent(last)
  } catch {
    // keep as is
  }
  const dot = last.lastIndexOf('.')
  const stem = dot > 0 ? last.slice(0, dot) : last
  return /^\d+$/.test(stem) || stem === '' ? 'Untitled' : stem
}

export async function applySongEdits(
  db: Database,
  library: LibraryQueries,
  songId: string,
  edits: TrackEdit,
  writeFileTags?: FileTagWriter
): Promise<boolean> {
  const current = db.get<{ path: string; artist: string; album_artist: string | null; album: string }>(
    'SELECT path, artist, album_artist, album FROM songs WHERE id = ?',
    [songId]
  )
  if (!current) return false

  const fileTags: DownloadTags = {}
  const dbSet: string[] = []
  const dbParams: unknown[] = []
  const REQUIRED: Record<string, string> = { title: stemOf(current.path), artist: 'Unknown Artist', album: 'Unknown Album' }

  const str = (key: keyof TrackEdit, column: string, tagKey?: keyof DownloadTags): void => {
    const value = edits[key]
    if (value === undefined) return
    let out = value === null || String(value).trim() === '' ? null : String(value).trim()
    if (out === null && REQUIRED[column]) out = REQUIRED[column]
    dbSet.push(`${column} = ?`)
    dbParams.push(out)
    if (tagKey && out !== null) (fileTags as Record<string, unknown>)[tagKey] = out
  }
  str('title', 'title', 'title')
  str('artist', 'artist', 'artist')
  str('albumArtist', 'album_artist', 'albumArtist')
  str('album', 'album', 'album')
  str('genre', 'genre', 'genre')
  str('composer', 'composer', 'composer')
  str('lyrics', 'lyrics', 'lyrics')

  const num = (key: keyof TrackEdit, column: string, tagKey?: keyof DownloadTags): void => {
    const value = edits[key]
    if (value === undefined) return
    const out = value == null || Number.isNaN(Number(value)) ? null : Number(value)
    dbSet.push(`${column} = ?`)
    dbParams.push(out)
    if (tagKey && out !== null && out > 0) (fileTags as Record<string, unknown>)[tagKey] = out
  }
  num('year', 'year', 'year')
  num('trackNo', 'track_no', 'trackNo')
  num('discNo', 'disc_no', 'discNo')
  num('rating', 'rating')

  if (dbSet.length === 0) return true
  // Artist / album grouping is by id: recompute it from the edited names.
  if (edits.artist !== undefined || edits.albumArtist !== undefined || edits.album !== undefined) {
    const val = (column: string, fallback: string): string => {
      const i = dbSet.indexOf(`${column} = ?`)
      return i >= 0 ? String(dbParams[i] ?? '') : fallback
    }
    const d = derivedIds(db, val('artist', current.artist), val('album_artist', current.album_artist ?? ''), val('album', current.album))
    dbSet.push('artist_id = ?', 'album_id = ?')
    dbParams.push(d.artistId, d.albumId)
  }
  dbParams.push(songId)
  db.run(`UPDATE songs SET ${dbSet.join(', ')} WHERE id = ?`, dbParams as never)

  if (writeFileTags && Object.keys(fileTags).length > 0 && current.path.startsWith('file://')) {
    try {
      await writeFileTags(current.path, fileTags)
    } catch {
      // the edit is saved in the library; the file just keeps its old tags
    }
  }
  library.rebuildAggregates()
  library.notifyChanged()
  return true
}
