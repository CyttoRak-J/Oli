/** IPC channel names shared between main, preload and renderer. */

export const IPC = {
  // General
  getAppInfo: 'app:get-info',
  onWindowControl: 'window:control',
  windowControl: 'window:control',
  onWindowStateChanged: 'window:state-changed',
  getWindowState: 'window:get-state',
  windowMoveBy: 'window:move-by',
  bubbleSnap: 'bubble:snap',
  bubbleReveal: 'bubble:reveal',

  // Settings
  getSettings: 'settings:get',
  setSettings: 'settings:set',
  onSettingsChanged: 'settings:changed',

  // Library / scanning
  getLibrary: 'library:get',
  getSongs: 'library:songs',
  getSongById: 'library:song-by-id',
  getAlbums: 'library:albums',
  getAlbumById: 'library:album-by-id',
  getAlbumSongs: 'library:album-songs',
  getArtists: 'library:artists',
  getArtistById: 'library:artist-by-id',
  getArtistAlbums: 'library:artist-albums',
  getArtistSongs: 'library:artist-songs',
  mergeAlbums: 'library:merge-albums',
  mergeArtists: 'library:merge-artists',
  getGenres: 'library:genres',
  getGenreSongs: 'library:genre-songs',
  getComposers: 'library:composers',
  getComposerSongs: 'library:composer-songs',
  addLibraryFolder: 'library:add-folder',
  removeLibraryFolder: 'library:remove-folder',
  rescanLibrary: 'library:rescan',
  cancelScan: 'library:cancel-scan',
  getScanState: 'library:scan-state',
  getStats: 'library:stats',

  // Scanner progress events
  onScanProgress: 'library:scan-progress',
  onLibraryChanged: 'library:changed',

  // Metadata / artwork
  getEmbeddedArtwork: 'artwork:get',
  getFolderArtwork: 'artwork:folder',
  refreshMetadata: 'metadata:refresh',
  editMetadata: 'metadata:edit',
  revealInExplorer: 'library:reveal',
  transcodeLocalFile: 'local:transcode',
  probeDuration: 'local:probe-duration',

  // Lyrics
  getLyrics: 'lyrics:get',
  refreshLyrics: 'lyrics:refresh',

  // Providers / online search
  search: 'search:run',
  onSearchOnline: 'search:online',
  getSearchHistory: 'search:history',
  clearSearchHistory: 'search:history-clear',
  removeSearchHistory: 'search:history-remove',
  pinSearch: 'search:pin',
  unpinSearch: 'search:unpin',
  isProviderConfigured: 'provider:configured',
  resolveYouTubeStream: 'youtube:resolve-stream',
  resolveYouTubeStreamBatch: 'youtube:resolve-stream-batch',
  resolveYouTubeUrl: 'youtube:resolve-url',
  resolvePlaylistEntries: 'youtube:resolve-playlist-entries',
  downloadYouTubeAudio: 'youtube:download-audio',
  openVideoWindow: 'video:open',
  videoDownload: 'video:download',
  videoDownloadSong: 'video:download-song',
  enqueuePlaylist: 'downloads:enqueue-playlist',
  videoPickFolder: 'video:pick-folder',
  videoFallbackUrl: 'video:fallback-url',
  videoRetry: 'video:retry',

  // Playlists
  getPlaylists: 'playlists:get',
  getPlaylist: 'playlists:get-one',
  getPlaylistEntries: 'playlists:entries',
  createPlaylist: 'playlists:create',
  updatePlaylist: 'playlists:update',
  deletePlaylist: 'playlists:delete',
  duplicatePlaylist: 'playlists:duplicate',
  addToPlaylist: 'playlists:add-tracks',
  removeFromPlaylist: 'playlists:remove-tracks',
  reorderPlaylist: 'playlists:reorder',
  movePlaylistToFolder: 'playlists:move-to-folder',
  importPlaylist: 'playlists:import',
  togglePlaylistPin: 'playlists:pin',
  evaluateSmartPlaylist: 'playlists:evaluate-smart',

  // Favorites
  getFavorites: 'favorites:get',
  toggleFavorite: 'favorites:toggle',

  // Queue / history / playback state
  getQueue: 'queue:get',
  saveQueue: 'queue:save',
  loadQueue: 'queue:load',
  clearQueue: 'queue:clear',
  getHistory: 'history:get',
  clearHistory: 'history:clear',
  restoreHistory: 'history:restore',
  getHistoryBackups: 'history:backups',
  onPlaybackState: 'playback:state',
  playbackState: 'playback:state',
  getPlaybackState: 'playback:get-state',
  commandPlayback: 'playback:command',
  onPlaybackCommand: 'playback:command-received',
  onTrackChanged: 'playback:track-changed',

  // Downloads
  getDownloads: 'downloads:get',
  enqueueDownload: 'downloads:enqueue',
  pauseDownload: 'downloads:pause',
  resumeDownload: 'downloads:resume',
  cancelDownload: 'downloads:cancel',
  retryDownload: 'downloads:retry',
  clearCompleted: 'downloads:clear-completed',
  clearPending: 'downloads:clear-pending',
  revealDownload: 'downloads:reveal',
  pauseAllDownload: 'downloads:pause-all',
  resumeAllDownload: 'downloads:resume-all',
  removeDownload: 'downloads:remove',
  onDownloadsChanged: 'downloads:changed',
  openDownloadsFolder: 'downloads:open-folder',

  // Metadata fix
  metaNeedsAttention: 'meta:needs-attention',
  metaFix: 'meta:fix',
  metaFixMany: 'meta:fix-many',
  metaFixAll: 'meta:fix-all',
  onMetaFixProgress: 'meta:fix-progress',

  // Backup / restore
  createBackup: 'backup:create',
  listBackups: 'backup:list',
  restoreBackup: 'backup:restore',
  exportLibrary: 'backup:export',
  importLibrary: 'backup:import',

  // Theme / accent
  onAccentPicked: 'theme:accent-picked',

  // Updates
  checkForUpdates: 'update:check',
  onUpdateStatus: 'update:status',
  openReleasePage: 'update:open',

  // Tray
  onTrayCommand: 'tray:command'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

export type { PlaybackState } from './types'