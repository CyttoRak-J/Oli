import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import NodeID3 from 'node-id3'
import { parseTrackBag } from './metadata'
import { artistIdFor, albumIdFor } from '../util/identity'
import type { ArtworkService } from './artwork'
import { getLogger } from './logger'
import type { Database } from './database'
import type { LibraryService } from './library'

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

/**
 * Metadata operations: manual refresh and database-level editing.
 *
 * For MP3 files edits are also written back to the ID3 tags on disk so they
 * survive rescans. Other formats are edited in the library database; a later
 * re-parse re-reads the original tags. Documented behavior.
 */
export class MetadataOpsService {
  constructor(
    private db: Database,
    private library: LibraryService,
    private artwork: ArtworkService
  ) {}

  private derivedIds(parsed: {
    artist: string
    albumArtist: string
    album: string
  }): { artistId: string; albumId: string } {
    const artistId = artistIdFor(parsed.artist)
    const albumId = albumIdFor(parsed.albumArtist, parsed.album)
    const artist = this.db.get<{ canonical_id: string }>(
      'SELECT canonical_id FROM merged_artists WHERE alias = ?',
      [artistId]
    )
    const album = this.db.get<{ canonical_id: string }>(
      'SELECT canonical_id FROM merged_albums WHERE alias = ?',
      [albumId]
    )
    return {
      artistId: artist?.canonical_id ?? artistId,
      albumId: album?.canonical_id ?? albumId
    }
  }

  refreshSong(songId: string): Promise<boolean> {
    const current = this.db.get<{ path: string }>('SELECT path FROM songs WHERE id = ?', [songId])
    if (!current) return Promise.resolve(false)
    return this.reparse(current.path, songId).then(() => true)
  }

  private async reparse(filePath: string, songId: string): Promise<void> {
    try {
      const stat = await fs.stat(filePath)
      const buffer = await fs.readFile(filePath)
      const source = { filePath, buffer, mtimeMs: stat.mtimeMs, size: stat.size }
      const parsed = await parseTrackBag(source)
      if (!parsed) return
      const derived = this.derivedIds(parsed)
      // Keep the disk-backed artwork cache in sync with the file: a metadata
      // fix re-embeds a fresh cover, so the old cached image must be replaced
      // (or dropped) or the app keeps displaying stale artwork. The cache is
      // keyed by the fully-qualified id ("song:..."), same as the scanner.
      const artKey = songId
      if (parsed.artwork) {
        this.artwork.store(artKey, parsed.artwork.data)
      } else {
        this.artwork.remove(artKey)
      }
      this.db.run(
        `UPDATE songs SET title=?, artist=?, artist_id=?, album_artist=?, album=?, album_id=?,
         genre=?, composer=?, year=?, track_no=?, disc_no=?, lyrics=?, duration=?, has_embedded_artwork=?, modified_at=? WHERE id=?`,
        [
          parsed.title,
          parsed.artist,
          derived.artistId,
          parsed.albumArtist,
          parsed.album,
          derived.albumId,
          parsed.genre,
          parsed.composer,
          parsed.year,
          parsed.trackNo,
          parsed.discNo,
          parsed.lyrics,
          parsed.duration,
          parsed.artwork ? 1 : 0,
          Math.floor(stat.mtimeMs),
          songId
        ]
      )
      this.library.rebuildAggregates()
      this.library.notifyChanged()
    } catch (err) {
      getLogger().warn(`Re-parse failed for ${filePath}`, err)
    }
  }

  /** Writes tag fields to the underlying file when the format supports it. */
  writeTagsToFile(
    filePath: string,
    edits: Record<string, string | number | { language: string; text: string }>
  ): boolean {
    if (path.extname(filePath).toLowerCase() !== '.mp3') return false
    try {
      const ok = NodeID3.write(edits, filePath)
      if (!ok) getLogger().warn(`ID3 write returned false: ${filePath}`)
      return Boolean(ok)
    } catch (err) {
      getLogger().warn(`ID3 write failed: ${filePath}`, err)
      return false
    }
  }

  applySongEdits(songId: string, edits: TrackEdit): boolean {
    const current = this.db.get<{ path: string }>('SELECT path FROM songs WHERE id = ?', [songId])
    if (!current) return false

    const tagPayload: Record<string, string | number | { language: string; text: string }> = {}
    const dbSet: string[] = []
    const dbParams: unknown[] = []

    const applyString = (key: keyof TrackEdit, column: string, tagKey?: string): void => {
      const value = edits[key]
      if (value === undefined) return
      const out = value === null || String(value).trim() === '' ? null : String(value).trim()
      dbSet.push(`${column} = ?`)
      dbParams.push(out)
      if (tagKey && out !== null) tagPayload[tagKey] = out
    }

    applyString('title', 'title', 'title')
    applyString('artist', 'artist', 'artist')
    applyString('albumArtist', 'album_artist', 'albumArtist')
    applyString('album', 'album', 'album')
    applyString('genre', 'genre', 'genre')
    applyString('composer', 'composer', 'composer')
    applyString('lyrics', 'lyrics', 'unsynchronisedLyrics')

    const applyNumber = (key: keyof TrackEdit, column: string, tagKey?: string): void => {
      const value = edits[key]
      if (value === undefined) return
      const out = value == null || Number.isNaN(Number(value)) ? null : Number(value)
      dbSet.push(`${column} = ?`)
      dbParams.push(out)
      if (tagKey && out !== null) tagPayload[tagKey] = String(out)
    }

    applyNumber('year', 'year', 'year')
    applyNumber('trackNo', 'track_no', 'trackNumber')
    applyNumber('discNo', 'disc_no', 'partOfSet')
    applyNumber('rating', 'rating', undefined)

    if (dbSet.length === 0) return true
    dbParams.push(songId)
    this.db.run(`UPDATE songs SET ${dbSet.join(', ')} WHERE id = ?`, dbParams)

    let wroteFile = false
    if (Object.keys(tagPayload).length > 0) {
      // node-id3 expects text with language + text object
      if (tagPayload['unsynchronisedLyrics']) {
        tagPayload['unsynchronisedLyrics'] = {
          language: 'eng',
          text: String(tagPayload['unsynchronisedLyrics'])
        }
      }
      wroteFile = this.writeTagsToFile(current.path, tagPayload)
    }

    if (wroteFile) getLogger().info(`Tags written to ${current.path}`)
    this.library.rebuildAggregates()
    return true
  }
}