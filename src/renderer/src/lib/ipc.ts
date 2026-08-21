import { IPC } from '@shared/ipc'
import type {
  Album,
  Artist,
  AppSettings,
  AttentionItem,
  ComposerInfo,
  DownloadItem,
  FavoriteItem,
  FixProgress,
  FixResult,
  Genre,
  LibraryFolder,
  LyricsData,
  OnlineSearchResult,
  Playlist,
  PlaylistEntry,
  PlaybackHistoryEntry,
  PlaybackState,
  QueueEntry,
  ScanProgress,
  SearchResults,
  Track
} from '@shared/types'

/** Thin typed wrapper around the context-bridged `window.cytto` API. */

export function call<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  return window.cytto.invoke(channel, ...args) as Promise<T>
}

export function send(channel: string, ...args: unknown[]): void {
  window.cytto.send(channel, ...args)
}

export function on<T = unknown>(
  channel: string,
  listener: (payload: T) => void
): () => void {
  return window.cytto.on(channel, listener as (...args: unknown[]) => void)
}

// ------------------------------------------------------------------ app
export const getAppInfo = (): Promise<{ name: string; version: string; electron: string; chrome: string; node: string }> =>
  call(IPC.getAppInfo)

// ----------------------------------------------------------------- window
export const windowControl = (
  action: 'minimize' | 'maximize' | 'close' | 'toggle-mini' | 'expand-mini' | 'to-bubble' | 'to-mini'
): Promise<void> => call(IPC.windowControl, action)
export const moveWindowBy = (dx: number, dy: number): Promise<void> => call(IPC.windowMoveBy, { dx, dy })
export const snapBubble = (): Promise<void> => call(IPC.bubbleSnap)
export const bubbleReveal = (): Promise<void> => call(IPC.bubbleReveal)
export const getWindowState = (): Promise<{ maximized: boolean; fullscreen: boolean }> =>
  call(IPC.getWindowState)

// ----------------------------------------------------------------- settings
export const getSettings = (): Promise<AppSettings> => call(IPC.getSettings)
export const setSettings = (patch: Partial<AppSettings>): Promise<AppSettings> => call(IPC.setSettings, patch)

// ----------------------------------------------------------------- library
export interface SongsResponse {
  tracks: Track[]
  total: number
}
export type SongsQuery = Record<string, unknown>
export const getSongs = (q?: SongsQuery): Promise<SongsResponse> => call(IPC.getSongs, q ?? {})
export const getSongById = (id: string): Promise<Track | null> => call(IPC.getSongById, id)
export const getAlbums = (): Promise<Album[]> => call(IPC.getAlbums)
export const getAlbumById = (id: string): Promise<Album | null> => call(IPC.getAlbumById, id)
export const getAlbumSongs = (id: string): Promise<Track[]> => call(IPC.getAlbumSongs, id)
export const getArtists = (): Promise<Artist[]> => call(IPC.getArtists)
export const getArtistById = (id: string): Promise<Artist | null> => call(IPC.getArtistById, id)
export const getArtistAlbums = (id: string): Promise<Album[]> => call(IPC.getArtistAlbums, id)
export const getArtistSongs = (id: string): Promise<Track[]> => call(IPC.getArtistSongs, id)
export const mergeAlbums = (canonicalId: string, aliasIds: string[]): Promise<number | null> =>
  call(IPC.mergeAlbums, canonicalId, aliasIds)
export const mergeArtists = (canonicalId: string, aliasIds: string[]): Promise<number | null> =>
  call(IPC.mergeArtists, canonicalId, aliasIds)
export const getGenres = (): Promise<Genre[]> => call(IPC.getGenres)
export const getGenreSongs = (g: string): Promise<Track[]> => call(IPC.getGenreSongs, g)
export const getComposers = (): Promise<ComposerInfo[]> => call(IPC.getComposers)
export const getComposerSongs = (c: string): Promise<Track[]> => call(IPC.getComposerSongs, c)

// ---------------------------------------------------------------- meta fix
export const getNeedsAttention = (): Promise<AttentionItem[]> => call(IPC.metaNeedsAttention)
export const fixMetadata = (path: string): Promise<FixResult> => call(IPC.metaFix, path)
export const fixMetadataMany = (paths: string[]): Promise<{ done: number; failed: number }> =>
  call(IPC.metaFixMany, paths)
export const fixAllMetadata = (force = false): Promise<{ done: number; failed: number }> =>
  call(IPC.metaFixAll, force)
export const onMetaFixProgress = (fn: (p: FixProgress) => void): (() => void) =>
  on<FixProgress>(IPC.onMetaFixProgress, fn)
export const getStats = (): Promise<{
  folderCount: number
  trackCount: number
  albumCount: number
  artistCount: number
  playlistCount: number
  favoriteCount: number
  missingCount: number
  totalDuration: number
  totalSize: number
}> => call(IPC.getStats)
export const getLibraryFolders = (): Promise<LibraryFolder[]> => call(IPC.getLibrary)
export const addLibraryFolder = (): Promise<LibraryFolder[] | null> => call(IPC.addLibraryFolder)
export const removeLibraryFolder = (id: string): Promise<void> => call(IPC.removeLibraryFolder, id)
export const rescanLibrary = (force = false): Promise<void> => call(IPC.rescanLibrary, force)
export const cancelScan = (): Promise<void> => call(IPC.cancelScan)
export const getScanState = (): Promise<ScanProgress | null> => call(IPC.getScanState)
export const revealInExplorer = (filePath: string): Promise<boolean> => call(IPC.revealInExplorer, filePath)

// ----------------------------------------------------------------- artwork / metadata
export const getEmbeddedArtwork = (songId: string): Promise<string | null> => call(IPC.getEmbeddedArtwork, songId)
export const refreshMetadata = (songId: string): Promise<boolean> => call(IPC.refreshMetadata, songId)
export const editMetadata = (songId: string, edits: Record<string, unknown>): Promise<boolean> =>
  call(IPC.editMetadata, songId, edits)

// ----------------------------------------------------------------- lyrics
export const getLyrics = (songId: string, force = false): Promise<LyricsData | null> =>
  call(IPC.getLyrics, songId, force)

// ----------------------------------------------------------------- providers / search
export const search = (
  query: string,
  filters?: { library?: boolean; spotify?: boolean; youtube?: boolean },
  record?: boolean
): Promise<SearchResults> => call(IPC.search, query, filters, record)
export const resolveYouTubeStream = (videoId: string): Promise<string[]> =>
  call(IPC.resolveYouTubeStream, videoId)
export const resolveYouTubeStreamBatch = (
  videoIds: string[]
): Promise<Array<{ videoId: string; urls: string[] }>> =>
  call(IPC.resolveYouTubeStreamBatch, videoIds)
export const resolveYouTubeUrl = (url: string): Promise<OnlineSearchResult[]> =>
  call(IPC.resolveYouTubeUrl, url)
export const resolvePlaylistEntries = (
  url: string
): Promise<{
  entries: Array<{
    videoId: string
    title: string
    duration?: number
    track?: { name: string; artists: string[]; album: string | null; durationMs: number | null }
  }>
  error?: string
  capped?: boolean
}> => call(IPC.resolvePlaylistEntries, url)
export const resolveDownloadYouTubeAudio = (videoId: string): Promise<string | null> =>
  call(IPC.downloadYouTubeAudio, videoId)
export const transcodeLocalFile = (filePath: string): Promise<string | null> =>
  call(IPC.transcodeLocalFile, filePath)
export const probeDuration = (filePath: string): Promise<number | null> =>
  call(IPC.probeDuration, filePath)
export const openVideoWindow = (videoId: string): Promise<void> => call(IPC.openVideoWindow, videoId)
export const getSearchHistory = (): Promise<Array<{ id: string; query: string; pinned: boolean; createdAt: number }>> =>
  call(IPC.getSearchHistory)
export const clearSearchHistory = (): Promise<void> => call(IPC.clearSearchHistory)
export const removeSearchHistory = (id: string): Promise<void> => call(IPC.removeSearchHistory, id)
export const pinSearch = (id: string): Promise<void> => call(IPC.pinSearch, id)
export const unpinSearch = (id: string): Promise<void> => call(IPC.unpinSearch, id)
export const isProviderConfigured = (): Promise<Record<string, boolean>> => call(IPC.isProviderConfigured)

// ----------------------------------------------------------------- playlists
export interface PlaylistInput {
  name: string
  description?: string
  type?: 'manual' | 'smart'
  rules?: unknown[] | null
}
export const getPlaylists = (): Promise<Playlist[]> => call(IPC.getPlaylists)
export const getPlaylist = (id: string): Promise<Playlist | null> => call(IPC.getPlaylist, id)
export const getPlaylistEntries = (id: string): Promise<PlaylistEntry[]> => call(IPC.getPlaylistEntries, id)
export const createPlaylist = (input: PlaylistInput): Promise<Playlist | null> => call(IPC.createPlaylist, input)
export const updatePlaylist = (id: string, input: Partial<PlaylistInput>): Promise<Playlist | null> =>
  call(IPC.updatePlaylist, id, input)
export const deletePlaylist = (id: string): Promise<void> => call(IPC.deletePlaylist, id)
export const duplicatePlaylist = (id: string): Promise<Playlist | null> => call(IPC.duplicatePlaylist, id)
export const addToPlaylist = (id: string, songIds: string[]): Promise<unknown> => call(IPC.addToPlaylist, id, songIds)
export const removeFromPlaylist = (id: string, songIds: string[]): Promise<unknown> =>
  call(IPC.removeFromPlaylist, id, songIds)
export const reorderPlaylist = (id: string, orderedIds: string[]): Promise<unknown> =>
  call(IPC.reorderPlaylist, id, orderedIds)
export const togglePlaylistPin = (id: string): Promise<unknown> => call(IPC.togglePlaylistPin, id)
export const importPlaylist = (): Promise<Playlist | null> => call(IPC.importPlaylist)

// ----------------------------------------------------------------- favorites
export const getFavorites = (itemType: string): Promise<FavoriteItem[]> => call(IPC.getFavorites, itemType)
export const toggleFavorite = (itemType: string, itemId: string): Promise<boolean> =>
  call(IPC.toggleFavorite, itemType, itemId)

// ----------------------------------------------------------------- playback / queue / history
export const getQueue = (): Promise<QueueEntry[]> => call(IPC.getQueue)
export const saveQueue = (entries: Array<{ id: string; songId: string; via?: string | null }>): Promise<void> =>
  call(IPC.saveQueue, entries)
export const clearQueue = (): Promise<void> => call(IPC.clearQueue)
export const getPlaybackState = (): Promise<PlaybackState> => call(IPC.getPlaybackState)
export const sendPlaybackState = (state: Partial<PlaybackState>): void => send(IPC.playbackState, state)
export const commandPlayback = (command: string): void => send(IPC.commandPlayback, command)
export const getHistory = (limit = 50): Promise<PlaybackHistoryEntry[]> => call(IPC.getHistory, limit)
export const clearHistory = (): Promise<void> => call(IPC.clearHistory)

// ----------------------------------------------------------------- downloads
export const getDownloads = (): Promise<DownloadItem[]> => call(IPC.getDownloads)
export const enqueueDownload = (url: string, title: string): Promise<DownloadItem | null> =>
  call(IPC.enqueueDownload, url, title)
export const enqueuePlaylist = (
  url: string,
  audio: string | null = null,
  destDir: string | null = null
): Promise<{ found: number; enqueued: number; error?: string; capped?: boolean }> =>
  call(IPC.enqueuePlaylist, url, audio, destDir)
export const pauseDownload = (id: string): Promise<void> => call(IPC.pauseDownload, id)
export const resumeDownload = (id: string): Promise<void> => call(IPC.resumeDownload, id)
export const cancelDownload = (id: string): Promise<void> => call(IPC.cancelDownload, id)
export const retryDownload = (id: string): Promise<void> => call(IPC.retryDownload, id)
export const clearCompletedDownloads = (): Promise<void> => call(IPC.clearCompleted)
export const clearPendingDownloads = (): Promise<number> => call(IPC.clearPending)
export const revealDownload = (id: string): Promise<boolean> => call(IPC.revealDownload, id)
export const pauseAllDownloads = (): Promise<number> => call(IPC.pauseAllDownload)
export const resumeAllDownloads = (): Promise<number> => call(IPC.resumeAllDownload)
export const removeDownload = (id: string, deleteFile = false): Promise<void> =>
  call(IPC.removeDownload, id, deleteFile)
export const videoDownload = (
  videoId: string,
  height: number | null = null,
  audio: string | null = null,
  destDir: string | null = null
): Promise<string | null> => call(IPC.videoDownload, videoId, height ?? 0, audio, destDir)
export const pickVideoFolder = (): Promise<string | null> => call(IPC.videoPickFolder)
export const videoDownloadSong = (
  videoId: string,
  audio: string | null = null,
  destDir: string | null = null
): Promise<string | null> => call(IPC.videoDownloadSong, videoId, audio, destDir)

// ----------------------------------------------------------------- backup / updates / system
export const createBackup = (): Promise<unknown> => call(IPC.createBackup)
export const listBackups = (): Promise<Array<{ id: string; createdAt: number }>> => call(IPC.listBackups)
export const restoreBackup = (): Promise<boolean> => call(IPC.restoreBackup)
export const checkForUpdates = (auto = false): Promise<{
  checked: boolean
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  updateUrl: string | null
  error: string | null
  checkedAt: number
}> => call(IPC.checkForUpdates, auto)