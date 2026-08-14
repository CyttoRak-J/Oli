export type ID = string

export interface PlaybackState {
  songId: string | null
  status: string
  currentTime: number
  duration: number
  volume: number
  muted: boolean
  shuffle: boolean
  repeat: string
  positionMeta: { queueIndex: number; queueLength: number }
  timestamp: number
  /** Display metadata for the current track (used by mini/bubble for online tracks). */
  title?: string | null
  artist?: string | null
  artworkUrl?: string | null
}

export interface Track {
  id: ID
  title: string
  artist: string
  artistId: ID | null
  albumArtist: string
  album: string
  albumId: ID | null
  genre: string | null
  composer: string | null
  year: number | null
  releaseDate: string | null
  trackNo: number | null
  discNo: number | null
  isrc: string | null
  rating: number | null
  duration: number
  bitrate: number | null
  sampleRate: number | null
  bitDepth: number | null
  channels: number | null
  codec: string | null
  format: string | null
  fileSize: number | null
  path: string
  folderId: ID | null
  libraryId: ID | null
  hash: string | null
  replayGain: number | null
  replayGainAlbum: number | null
  lyrics: string | null
  hasEmbeddedArtwork: boolean
  addedAt: number
  modifiedAt: number
  lastPlayedAt: number | null
  playCount: number | null
  favorite: boolean
  missing: boolean
  error: string | null
  /** Direct audio stream URL (online providers, e.g. resolved YouTube streams). */
  streamUrl?: string
  /** Ordered fallback stream URLs (lower quality/other formats) tried in order if `streamUrl` fails. */
  streamUrls?: string[]
  /** Remote artwork (online providers, e.g. YouTube thumbnails). */
  artworkUrl?: string | null
}

export interface Album {
  id: ID
  title: string
  artist: string
  year: number | null
  genre: string | null
  trackId: ID | null
  trackCount: number
  totalDuration: number
  favorite: boolean
  hasEmbeddedArtwork: boolean
  addedAt: number
}

export interface Artist {
  id: ID
  name: string
  sortName: string
  genre: string | null
  biography: string | null
  favorite: boolean
  trackCount: number
  albumCount: number
  addedAt: number
}

export interface Genre {
  id: ID
  name: string
  trackCount: number
}

export interface ComposerInfo {
  name: string
  trackCount: number
  albumCount: number
}

/** A library file whose metadata may need re-fixing. */
export interface AttentionItem {
  path: string
  songId: string | null
  title: string
  videoId: string | null
  reasons: string[]
}

export interface FixResult {
  ok: boolean
  path: string
  songId: string | null
  reason?: string
  provider?: string | null
  title?: string | null
  artist?: string | null
  composer?: string | null
}

/**
 * Tag fields embedded into a downloaded audio file. Produced by catalog
 * lookups and consumed by the tagging step; shared so every wire boundary
 * (provider, fix service, download hooks) declares the same shape.
 */
export interface TrackTagInput {
  title: string
  channel: string | null
  thumbnail: string | null
  artist?: string | null
  album?: string | null
  genres?: string[]
  coverUrl?: string | null
  composer?: string | null
  year?: number | null
  /** Position within the album/soundtrack (1-based). */
  trackNo?: number | null
}

export interface FixProgress {
  running: boolean
  done: number
  total: number
  currentPath: string | null
  last?: FixResult
  failed: number
  /** Every failed fix of this run (path + reason), for reporting/retry. */
  failures: FixResult[]
}

export type PlaylistKind = 'manual' | 'smart'

export interface SmartRule {
  field: string
  operator: 'equals' | 'notEquals' | 'contains' | 'notContains' | 'is' | 'isNot' |
    'before' | 'after' | 'between' | 'greaterThan' | 'lessThan' | 'matchesAny' | 'startsWith'
  value: string | number | Array<string | number> | null
}

export interface Playlist {
  id: ID
  name: string
  description: string
  type: PlaylistKind
  rules: SmartRule[] | null
  folderId: ID | null
  position: number
  pinned: boolean
  favorite: boolean
  trackCount: number
  totalDuration: number | null
  createdAt: number
  updatedAt: number
}

export interface PlaylistEntry {
  id: ID
  playlistId: ID
  songId: ID
  position: number
  addedAt: number
  track: Track
}

export interface QueueEntry {
  id: ID
  songId: ID
  position: number
  queuedAt: number
  track: Track
  via: string | null
}

export interface PlaybackItem {
  track: Track
  source: 'library' | 'playlist' | 'album' | 'artist' | 'queue' | 'search' | 'favorites' | 'downloads'
  sourceId: string | null
}

export interface PlaybackHistoryEntry {
  id: ID
  songId: ID
  playedAt: number
  completed: boolean
  durationSeconds: number
  track?: Track
}

export interface FavoriteItem {
  id: ID
  itemType: 'song' | 'album' | 'artist' | 'playlist'
  itemId: ID
  createdAt: number
}

export interface LibraryFolder {
  id: ID
  path: string
  addedAt: number
  trackCount: number
  totalSize: number
  lastScanAt: number | null
}

export interface DownloadItem {
  id: ID
  title: string
  url: string
  destPath: string
  state: 'queued' | 'downloading' | 'paused' | 'completed' | 'failed' | 'canceled'
  progress: number
  totalBytes: number | null
  downloadedBytes: number
  speed: number
  etaSeconds: number | null
  error: string | null
  missing?: boolean
  createdAt: number
  updatedAt: number
}

export interface ScanProgress {
  libraryId: ID | null
  phase: 'idle' | 'discovering' | 'reading' | 'indexing' | 'finished' | 'error'
  currentFile: string | null
  filesFound: number
  filesProcessed: number
  filesAdded: number
  filesUpdated: number
  filesRemoved: number
  skippedUnsupported: number
  skippedDuplicates: number
  itemsWithErrors: number
  message: string | null
  canceled?: boolean
}

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended'

export type RepeatMode = 'off' | 'queue' | 'one'

export interface LyricsData {
  synced: boolean
  source: string | null
  lyrics: string
  fetchedAt: number
}

export interface EqualizerPreset {
  name: string
  preamp: number
  bands: number[] // 10 bands dB
}

export interface EqualizerOptions {
  enabled: boolean
  preset: string
  preamp: number
  bands: number[]
}

export type ThemeMode = 'dark' | 'light' | 'amoled'

export interface AppSettings {
  themeMode: ThemeMode
  accentColor: string | null
  accentFromArtwork: boolean
  reduceMotion: boolean
  crossfadeSeconds: number
  replayGainMode: 'off' | 'track' | 'album'
  volume: number
  playbackSpeed: number
  preservePitch: boolean
  shuffle: boolean
  repeat: RepeatMode
  resumeOnLaunch: boolean
  showTrayIcon: boolean
  minimizeToTray: boolean
  closeToTray: boolean
  mediaKeysEnabled: boolean
  taskbarProgressEnabled: boolean
  miniPlayerAlwaysOnTop: boolean
  miniPlayerTaskbar: boolean
  miniPlayerOpacity: number
  bubblePosition: { x: number; y: number } | null
  notificationsEnabled: boolean
  cacheArtworkMB: number
  scanOnLaunch: boolean
  watchFolders: boolean
  autoUpdateEnabled: boolean
  telemetryLocal: boolean
  equalizer: EqualizerOptions
  language: string
  lyricsOnline: 'enabled' | 'disabled'
  spotifyClientId: string
  spotifyClientSecret: string
  youtubeApiKey: string
  /** Free AcoustID API key (acoustid.org) enabling audio-fingerprint metadata matching. */
  acoustidApiKey: string
  /** How many queued songs get their metadata prepared ahead of download time (1-5). */
  songsAhead: number
  /** How many YouTube downloads may run at once (1-3; >1 risks YouTube bot checks). */
  ytConcurrency: number
  lastPage: string
  lastSongId: ID | null
  lastPositionSeconds: number
}

export interface MiniPlayerInit {
  windowId: string
  mode: 'floating'
}

export interface SearchSource {
  kind: 'local' | 'spotify' | 'youtube' | 'lyrics'
  label: string
  enabled: boolean
}

export interface OnlineSearchResult {
  provider: string
  id: string
  title: string
  artist: string
  album: string | null
  duration: number | null
  year: number | null
  artworkUrl: string | null
  url: string
  previewUrl: string | null
  localMatch?: Track | null
  /** YouTube video id (allows internal audio/video playback). */
  videoId?: string | null
}

export interface SearchFilters {
  library?: boolean
  spotify?: boolean
  youtube?: boolean
}

export interface SearchResults {
  local: Track[]
  online: OnlineSearchResult[]
  suggestions: string[]
  /** True once all online providers finished (even with zero results). */
  onlineDone?: boolean
}

export interface HistoryRestorePoint {
  id: string
  createdAt: number
  file: string
}

export interface ThumbnailButtons {
  enabled: boolean
}

export interface NotificationPayload {
  title: string
  body: string
  icon?: string
}

export interface LegacySettingsRecord {
  key: string
  value: string
}