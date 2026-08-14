import type {
  Album,
  Artist,
  FavoriteItem,
  Genre,
  LibraryFolder,
  Playlist,
  PlaylistEntry,
  QueueEntry,
  Track
} from '@shared/types'

function bool(v: unknown): boolean {
  return v === 1 || v === true || v === '1' || v === 'true'
}

export function toTrack(row: Record<string, unknown>): Track {
  return {
    id: String(row.id),
    title: String(row.title ?? 'Unknown Title'),
    artist: String(row.artist ?? 'Unknown Artist'),
    artistId: row.artist_id ? String(row.artist_id) : null,
    albumArtist: row.album_artist ? String(row.album_artist) : String(row.artist ?? ''),
    album: String(row.album ?? 'Unknown Album'),
    albumId: row.album_id ? String(row.album_id) : null,
    genre: row.genre ? String(row.genre) : null,
    composer: row.composer ? String(row.composer) : null,
    year: row.year != null ? Number(row.year) : null,
    releaseDate: row.release_date ? String(row.release_date) : null,
    trackNo: row.track_no != null ? Number(row.track_no) : null,
    discNo: row.disc_no != null ? Number(row.disc_no) : null,
    isrc: row.isrc ? String(row.isrc) : null,
    rating: row.rating != null ? Number(row.rating) : null,
    duration: Number(row.duration ?? 0),
    bitrate: row.bitrate != null ? Number(row.bitrate) : null,
    sampleRate: row.sample_rate != null ? Number(row.sample_rate) : null,
    bitDepth: row.bit_depth != null ? Number(row.bit_depth) : null,
    channels: row.channels != null ? Number(row.channels) : null,
    codec: row.codec ? String(row.codec) : null,
    format: row.format ? String(row.format) : null,
    fileSize: row.file_size != null ? Number(row.file_size) : null,
    path: String(row.path),
    folderId: row.folder_id ? String(row.folder_id) : null,
    libraryId: row.library_id ? String(row.library_id) : null,
    hash: row.content_hash ? String(row.content_hash) : null,
    replayGain: row.replay_gain != null ? Number(row.replay_gain) : null,
    replayGainAlbum: row.replay_gain_album != null ? Number(row.replay_gain_album) : null,
    lyrics: row.lyrics ? String(row.lyrics) : null,
    hasEmbeddedArtwork: bool(row.has_embedded_artwork),
    addedAt: Number(row.added_at ?? 0),
    modifiedAt: Number(row.modified_at ?? 0),
    lastPlayedAt: row.last_played_at != null ? Number(row.last_played_at) : null,
    playCount: Number(row.play_count ?? 0),
    favorite: bool(row.favorite),
    missing: bool(row.missing),
    error: row.error ? String(row.error) : null
  }
}

export function toAlbum(row: Record<string, unknown>): Album {
  return {
    id: String(row.id),
    title: String(row.title ?? 'Unknown Album'),
    artist: String(row.artist ?? 'Unknown Artist'),
    year: row.year != null ? Number(row.year) : null,
    genre: row.genre ? String(row.genre) : null,
    trackId: row.track_id ? String(row.track_id) : null,
    trackCount: Number(row.track_count ?? 0),
    totalDuration: Number(row.total_duration ?? 0),
    favorite: bool(row.favorite),
    hasEmbeddedArtwork: bool(row.has_embedded_artwork),
    addedAt: Number(row.added_at ?? 0)
  }
}

export function toArtist(row: Record<string, unknown>): Artist {
  return {
    id: String(row.id),
    name: String(row.name ?? 'Unknown Artist'),
    sortName: row.sort_name ? String(row.sort_name) : String(row.name ?? ''),
    genre: row.genre ? String(row.genre) : null,
    biography: row.biography ? String(row.biography) : null,
    favorite: bool(row.favorite),
    trackCount: Number(row.track_count ?? 0),
    albumCount: Number(row.album_count ?? 0),
    addedAt: Number(row.added_at ?? 0)
  }
}

export function toGenre(row: Record<string, unknown>): Genre {
  return {
    id: String(row.id),
    name: String(row.name),
    trackCount: Number(row.track_count ?? 0)
  }
}

export function toPlaylist(
  row: Record<string, unknown>,
  trackCount: number,
  totalDuration: number | null
): Playlist {
  let rules = null
  if (row.rules_json) {
    try {
      rules = JSON.parse(String(row.rules_json))
    } catch {
      rules = null
    }
  }
  return {
    id: String(row.id),
    name: String(row.name),
    description: row.description ? String(row.description) : '',
    type: row.type === 'smart' ? 'smart' : 'manual',
    rules,
    folderId: row.folder_id ? String(row.folder_id) : null,
    position: Number(row.position ?? 0),
    pinned: bool(row.pinned),
    favorite: bool(row.favorite),
    trackCount,
    totalDuration,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0)
  }
}

export function toPlaylistEntry(row: Record<string, unknown>): PlaylistEntry {
  return {
    id: String(`${row.playlist_id}-${row.song_id}`),
    playlistId: String(row.playlist_id),
    songId: String(row.song_id),
    position: Number(row.position ?? 0),
    addedAt: Number(row.added_at ?? 0),
    track: toTrack(row)
  }
}

export function toQueueEntry(row: Record<string, unknown>): QueueEntry {
  return {
    id: String(row.id),
    songId: String(row.song_id),
    position: Number(row.position ?? 0),
    queuedAt: Number(row.queued_at ?? 0),
    via: row.via ? String(row.via) : null,
    track: toTrack(row)
  }
}

export function toFavoriteItem(row: Record<string, unknown>): FavoriteItem {
  return {
    id: String(row.id),
    itemType: (row.item_type as FavoriteItem['itemType']) ?? 'song',
    itemId: String(row.item_id),
    createdAt: Number(row.created_at ?? 0)
  }
}

export function toLibraryFolder(row: Record<string, unknown>): LibraryFolder {
  return {
    id: String(row.id),
    path: String(row.path),
    addedAt: Number(row.added_at ?? 0),
    lastScanAt: row.last_scan_at != null ? Number(row.last_scan_at) : null,
    trackCount: Number(row.trackCount ?? row.track_count ?? 0),
    totalSize: Number(row.totalSize ?? row.total_size ?? 0)
  }
}

export interface LibraryStatsResponse {
  library: {
    folderCount: number
    trackCount: number
    albumCount: number
    artistCount: number
    playlistCount: number
    favoriteCount: number
    missingCount: number
    totalDuration: number
    totalSize: number
  }
}