import type { OnlineSearchResult, Track } from '@shared/types'

/** Build a playable Track from an online result whose stream URLs are resolved. */
export function onlineToTrack(r: OnlineSearchResult, streamUrls: string[]): Track {
  return {
    id: r.id,
    title: r.title,
    artist: r.artist,
    artistId: null,
    albumArtist: r.artist,
    album: r.album ?? '',
    albumId: null,
    genre: null,
    composer: null,
    year: r.year,
    releaseDate: null,
    trackNo: null,
    discNo: null,
    isrc: null,
    rating: null,
    duration: r.duration ?? 0,
    bitrate: null,
    sampleRate: null,
    bitDepth: null,
    channels: null,
    codec: null,
    format: null,
    fileSize: null,
    // Online tracks have no local file; an empty path routes them to the
    // stream-resolving playback pipeline (a URL here would make the player
    // try to open it as a local file and fail).
    path: '',
    folderId: null,
    libraryId: null,
    hash: null,
    replayGain: null,
    replayGainAlbum: null,
    lyrics: null,
    hasEmbeddedArtwork: false,
    addedAt: Date.now(),
    modifiedAt: Date.now(),
    lastPlayedAt: null,
    playCount: null,
    favorite: false,
    missing: false,
    error: null,
    streamUrl: streamUrls[0] ?? '',
    streamUrls,
    artworkUrl: r.artworkUrl
  }
}
