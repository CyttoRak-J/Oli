import { describe, it, expect } from 'vitest'
import {
  toTrack,
  toQueueEntry,
  toAlbum,
  toArtist,
  toGenre,
  toLibraryFolder,
  toPlaylist,
  toPlaylistEntry,
  toFavoriteItem
} from '../src/main/services/mappers'

// These rows mirror exactly what migrations.ts creates and what the SQL in
// library.ts / playlists.ts / favorites.ts / scanner.ts selects. If a schema
// column gets renamed, these tests should fail loudly instead of the bug
// surfacing later as a blank Albums page or crash at runtime.

describe('toTrack', () => {
  it('maps a full songs row', () => {
    const row = {
      id: 'song:abc', title: 'Test Song', artist: 'Test Artist', artist_id: 'artist:1',
      album_artist: 'Test Artist', album: 'Test Album', album_id: 'album:1',
      genre: 'Rock', composer: null, year: 2020, release_date: '2020-01-01',
      track_no: 1, disc_no: 1, isrc: null, rating: 5, duration: 180.5,
      bitrate: 320, sample_rate: 44100, bit_depth: 16, channels: 2,
      codec: 'mp3', format: 'MP3', file_size: 5000000, path: '/music/test.mp3',
      folder_id: 'folder:1', library_id: 'lib:1', content_hash: 'hash123',
      replay_gain: -6.5, replay_gain_album: -7.2, lyrics: null,
      has_embedded_artwork: 1, added_at: 1000, modified_at: 2000,
      last_played_at: 3000, play_count: 4, favorite: 1, missing: 0, error: null
    }
    const track = toTrack(row)
    expect(track.id).toBe('song:abc')
    expect(track.title).toBe('Test Song')
    expect(track.favorite).toBe(true)
    expect(track.missing).toBe(false)
    expect(track.hasEmbeddedArtwork).toBe(true)
    expect(track.duration).toBe(180.5)
    expect(track.playCount).toBe(4)
  })

  it('falls back to sane defaults for missing/null fields', () => {
    const track = toTrack({ id: 'song:x', path: '/x.mp3' })
    expect(track.title).toBe('Unknown Title')
    expect(track.artist).toBe('Unknown Artist')
    expect(track.album).toBe('Unknown Album')
    expect(track.favorite).toBe(false)
    expect(track.duration).toBe(0)
  })
})

describe('toQueueEntry', () => {
  it('maps a queue row joined with songs', () => {
    const row = { id: 'q1', song_id: 'song:abc', position: 0, queued_at: 1000, via: 'search', path: '/x.mp3', title: 'X' }
    const entry = toQueueEntry(row)
    expect(entry.id).toBe('q1')
    expect(entry.songId).toBe('song:abc')
    expect(entry.track.title).toBe('X')
  })
})

describe('toAlbum', () => {
  it('maps album rows including the joined has_embedded_artwork subquery', () => {
    const row = {
      id: 'album:1', title: 'OK Computer', artist: 'Radiohead', year: 1997,
      genre: 'Alternative', track_id: 'song:1', track_count: 12,
      total_duration: 3200, favorite: 1, has_embedded_artwork: 1, added_at: 1000
    }
    const album = toAlbum(row)
    expect(album.title).toBe('OK Computer')
    expect(album.trackCount).toBe(12)
    expect(album.favorite).toBe(true)
    expect(album.hasEmbeddedArtwork).toBe(true)
  })
})

describe('toArtist', () => {
  it('maps artist rows', () => {
    const row = {
      id: 'artist:1', name: 'Radiohead', sort_name: 'radiohead', genre: 'Alternative',
      biography: null, favorite: 0, track_count: 50, album_count: 9, added_at: 1000
    }
    const artist = toArtist(row)
    expect(artist.name).toBe('Radiohead')
    expect(artist.albumCount).toBe(9)
    expect(artist.favorite).toBe(false)
  })
})

describe('toGenre', () => {
  it('maps genre rows', () => {
    const genre = toGenre({ id: 'genre:1', name: 'Rock', track_count: 100 })
    expect(genre.name).toBe('Rock')
    expect(genre.trackCount).toBe(100)
  })
})

describe('toLibraryFolder', () => {
  it('maps the camelCase aliases used by the library.ts subqueries', () => {
    // library.ts aliases the COUNT()/SUM() subqueries as `trackCount`/`totalSize`
    // (camelCase) directly in the SQL, NOT snake_case like the other tables.
    const row = { id: 'folder:1', path: '/Music', added_at: 1000, last_scan_at: 2000, trackCount: 42, totalSize: 999 }
    const folder = toLibraryFolder(row)
    expect(folder.trackCount).toBe(42)
    expect(folder.totalSize).toBe(999)
  })
})

describe('toPlaylist', () => {
  it('maps playlist rows and applies externally-computed trackCount/totalDuration', () => {
    const row = {
      id: 'pl:1', name: 'Road Trip', description: '', type: 'manual',
      rules_json: null, folder_id: null, position: 0, pinned: 0, favorite: 1,
      created_at: 1000, updated_at: 2000
    }
    const playlist = toPlaylist(row, 5, 900)
    expect(playlist.name).toBe('Road Trip')
    expect(playlist.trackCount).toBe(5)
    expect(playlist.totalDuration).toBe(900)
    expect(playlist.favorite).toBe(true)
  })

  it('parses rules_json for smart playlists', () => {
    const rules = [{ field: 'genre', op: 'equals', value: 'Rock' }]
    const row = {
      id: 'pl:2', name: 'Rock Mix', description: '', type: 'smart',
      rules_json: JSON.stringify(rules), folder_id: null, position: 0,
      pinned: 0, favorite: 0, created_at: 1000, updated_at: 2000
    }
    const playlist = toPlaylist(row, 0, 0)
    expect(playlist.type).toBe('smart')
    expect(playlist.rules).toEqual(rules)
  })

  it('does not throw on malformed rules_json', () => {
    const row = {
      id: 'pl:3', name: 'Broken', description: '', type: 'smart',
      rules_json: '{not valid json', folder_id: null, position: 0,
      pinned: 0, favorite: 0, created_at: 1000, updated_at: 2000
    }
    expect(() => toPlaylist(row, 0, 0)).not.toThrow()
    expect(toPlaylist(row, 0, 0).rules).toBeNull()
  })
})

describe('toPlaylistEntry', () => {
  it('maps playlist_tracks rows joined with songs', () => {
    const row = { playlist_id: 'pl:1', song_id: 'song:1', position: 0, added_at: 1000, id: 'song:1', title: 'Track One', path: '/t.mp3' }
    const entry = toPlaylistEntry(row)
    expect(entry.playlistId).toBe('pl:1')
    expect(entry.songId).toBe('song:1')
    expect(entry.track.title).toBe('Track One')
  })
})

describe('toFavoriteItem', () => {
  it('maps favorites rows', () => {
    const fav = toFavoriteItem({ id: 'f1', item_type: 'album', item_id: 'album:1', created_at: 1000 })
    expect(fav.itemType).toBe('album')
    expect(fav.itemId).toBe('album:1')
  })
})
