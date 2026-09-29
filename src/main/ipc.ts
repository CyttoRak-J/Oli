import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { IPC } from '@shared/ipc'
import { ANALYTICS_KEYS, APP_NAME } from '@shared/constants'
import { getLogger } from './services/logger'
import { buildDownloadUrl, isValidIdentifier } from './services/archive'
import { runMigrations } from './services/migrations'
import type { AppPaths } from './paths'
import type { ArchiveService } from './services/archive'
import type { YtdlpEngine } from './services/ytdlpEngine'
import type { ArtworkService } from './services/artwork'
import type { BackupService } from './services/backup'
import type { DownloadService } from './services/downloads'
import type { FavoritesService } from './services/favorites'
import type { LibraryService } from './services/library'
import type { LyricsService } from './services/lyrics'
import type { MetadataOpsService } from './services/metadataOps'
import type { MetaFixService } from './services/metaFix'
import type { PlaylistService } from './services/playlists'
import type { PlaybackStateStore, QueueService, HistoryService } from './services/playerState'
import type { ProviderService } from './services/provider'
import type { SearchService } from './services/search'
import type { SettingsStore } from './services/settingsStore'
import type { NotificationService } from './services/notifications'
import type { TranscodeService } from './services/transcode'
import type { MediaServer } from './services/mediaServer'
import type { UpdaterService } from './services/updater'
import type { AnalyticsService } from './services/analytics'
import type { WindowManager } from './windows'
import type { TrayManager } from './tray'
import type { AppSettings, SearchFilters } from '@shared/types'

export interface ServiceContainer {
  db: import('./services/database').Database
  settings: SettingsStore
  library: LibraryService
  artwork: ArtworkService
  lyrics: LyricsService
  providers: ProviderService
  search: SearchService
  playlists: PlaylistService
  favorites: FavoritesService
  playback: PlaybackStateStore
  queue: QueueService
  history: HistoryService
  downloads: DownloadService
  archive: ArchiveService
  ytEngine: YtdlpEngine
  backup: BackupService
  updater: UpdaterService
  analytics: AnalyticsService
  notifications: NotificationService
  metadataOps: MetadataOpsService
  metaFix: MetaFixService
  transcode: TranscodeService
  media: MediaServer
  windows: WindowManager
  tray: TrayManager
  paths: AppPaths
}

function toResult<T>(fn: () => T): T | null {
  try {
    return fn()
  } catch (err) {
    getLogger().error('IPC handler error', err)
    return null
  }
}

export function registerIpc(services: ServiceContainer): void {
  const { settings, library, artwork, lyrics, providers, search, playlists, favorites, playback, queue, history, downloads, archive, ytEngine, backup, updater, analytics, metadataOps, metaFix, transcode, media, windows, tray, paths, db } = services

  // ------------------------------------------------------------------ app
  ipcMain.handle(IPC.getAppInfo, () => ({
    name: APP_NAME,
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }))

  // ----------------------------------------------------------------- window
  ipcMain.handle(IPC.windowControl, (_e, action: string) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    if (!win) return
    switch (action) {
      case 'minimize':
        win.minimize()
        break
      case 'maximize':
        if (win.isMaximized()) win.unmaximize()
        else win.maximize()
        break
      case 'close':
        win.close()
        break
      case 'toggle-mini':
        windows.createMiniWindow()
        break
      case 'expand-mini':
        windows.expandMini()
        break
      case 'to-bubble':
        windows.toBubble()
        break
      case 'to-mini':
        windows.toMini()
        break
    }
  })

  ipcMain.handle(IPC.windowMoveBy, (e, delta: { dx?: number; dy?: number }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    windows.cancelBubbleSnap()
    const [x, y] = win.getPosition()
    const [w, h] = win.getSize()
    const dx = Math.round(Number(delta?.dx) || 0)
    const dy = Math.round(Number(delta?.dy) || 0)
    // Keep the dragged window fully on screen (bubble stays visible while dragging).
    const { workArea } = screen.getDisplayMatching(win.getBounds())
    const nx = Math.min(Math.max(x + dx, workArea.x), workArea.x + workArea.width - w)
    const ny = Math.min(Math.max(y + dy, workArea.y), workArea.y + workArea.height - h)
    win.setPosition(nx, ny)
    windows.persistBubblePosition()
  })

  ipcMain.handle(IPC.bubbleSnap, () => windows.snapBubble())
  ipcMain.handle(IPC.bubbleReveal, () => windows.bubbleReveal())

  ipcMain.handle(IPC.getWindowState, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return { maximized: false, fullscreen: false }
    return { maximized: win.isMaximized(), fullscreen: win.isFullScreen() }
  })

  // ----------------------------------------------------------------- settings
  ipcMain.handle(IPC.getSettings, () => settings.all())
  ipcMain.handle(IPC.setSettings, (_e, patch: Partial<AppSettings>) => {
    // setMany stringifies each value itself; pre-stringifying objects here
    // would double-encode them.
    // setMany emits 'changed', which applies runtime settings (listener below).
    settings.setMany(patch)
    // Settings UI and any window may react (sender included: the store also
    // learns of changes made from other windows, e.g. the mini player)
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.onSettingsChanged, patch)
      }
    }
    return settings.all()
  })

  // Only settings that affect windows / tray need re-applying. Playback
  // bookkeeping (lastSongId, lastPositionSeconds every few seconds, bubble
  // position while dragging) must not re-theme and re-pin every window.
  const RUNTIME_KEYS = [
    'closeToTray',
    'taskbarProgressEnabled',
    'miniPlayerTaskbar',
    'miniPlayerAlwaysOnTop',
    'themeMode',
    'showTrayIcon'
  ]
  settings.on('changed', (changed: Record<string, unknown>) => {
    if (RUNTIME_KEYS.some((k) => k in changed)) applyRuntimeSettings(services)
  })

  // ----------------------------------------------------------------- library
  ipcMain.handle(IPC.getLibrary, () => library.getFolders())
  ipcMain.handle(IPC.getSongs, (_e, q) => library.querySongs(q ?? {}))
  ipcMain.handle(IPC.getSongById, (_e, id) => library.getSongById(id))
  ipcMain.handle(IPC.getAlbums, () => library.getAlbums())
  ipcMain.handle(IPC.getAlbumById, (_e, id) => library.getAlbumById(id))
  ipcMain.handle(IPC.getAlbumSongs, (_e, id) => library.getAlbumSongs(id))
  ipcMain.handle(IPC.getArtists, () => library.getArtists())
  ipcMain.handle(IPC.getArtistById, (_e, id) => library.getArtistById(id))
  ipcMain.handle(IPC.getArtistAlbums, (_e, id) => library.getArtistAlbums(id))
  ipcMain.handle(IPC.getArtistSongs, (_e, id) => library.getArtistSongs(id))
  ipcMain.handle(IPC.mergeAlbums, (_e, canonicalId: string, aliasIds: string[]) =>
    toResult(() => library.mergeAlbums(canonicalId, aliasIds))
  )
  ipcMain.handle(IPC.mergeArtists, (_e, canonicalId: string, aliasIds: string[]) =>
    toResult(() => library.mergeArtists(canonicalId, aliasIds))
  )
  ipcMain.handle(IPC.getGenres, () => library.getGenres())
  ipcMain.handle(IPC.getGenreSongs, (_e, g) => library.getGenreSongs(g))
  ipcMain.handle(IPC.getSimilarTracks, (_e, songId: string, excludeIds: string[], limit?: number) =>
    library.getSimilarTracks(songId, excludeIds, limit)
  )
  ipcMain.handle(IPC.getComposers, () => library.getComposers())
  ipcMain.handle(IPC.getComposerSongs, (_e, c) => library.getComposerSongs(c))
  ipcMain.handle(IPC.metaNeedsAttention, () => metaFix.attention())
  ipcMain.handle(IPC.metaFix, (_e, path: string) => metaFix.fix(path))
  ipcMain.handle(IPC.metaFixMany, (_e, paths: string[]) => metaFix.fixMany(paths))
  ipcMain.handle(IPC.metaFixAll, (_e, force?: boolean) => metaFix.fixAll(Boolean(force)))
  ipcMain.handle(IPC.getStats, () => library.getStats())
  ipcMain.handle(IPC.getScanState, () => library.lastProgress)
  ipcMain.handle(IPC.rescanLibrary, (_e, force: boolean) =>
    toResult(() => void library.scanLibrary(undefined, force))
  )
  ipcMain.handle(IPC.cancelScan, () => library.cancelScan())

  ipcMain.handle(IPC.addLibraryFolder, async () => {
    const result = await dialog.showOpenDialog(windows.getMain()!, {
      title: 'Add music folder',
      properties: ['openDirectory', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const folders = []
    for (const dir of result.filePaths) {
      const folder = await library.addFolder(dir)
      if (folder) folders.push(folder)
    }
    return folders
  })

  ipcMain.handle(IPC.removeLibraryFolder, (_e, id: string) => toResult(() => library.removeFolder(id)))

  ipcMain.handle(IPC.revealInExplorer, (_e, filePath: string) => {
    try {
      shell.showItemInFolder(filePath)
      return true
    } catch {
      return false
    }
  })
  ipcMain.handle(IPC.getMediaBase, () => media.baseUrl)
  ipcMain.handle(IPC.transcodeLocalFile, async (_e, filePath: string) => {
    try {
      return await transcode.transcodeToMp3(filePath)
    } catch (err) {
      getLogger().error('Transcode IPC error', err)
      return null
    }
  })
  ipcMain.handle(IPC.probeDuration, async (_e, filePath: string) => {
    try {
      return await transcode.probeDuration(filePath)
    } catch {
      return null
    }
  })

  // ----------------------------------------------------------------- artwork
  ipcMain.handle(IPC.getEmbeddedArtwork, (_e, songId: string) => {
    const embedded = artwork.get(songId)
    if (embedded) return artworkURL(songId)
    const track = library.getSongById(songId)
    if (!track) {
      // No own artwork: reuse a sibling's cover inside the same merged album.
      const sibling = artwork.albumCoverSource(songId)
      if (sibling) return artworkURL(sibling)
      return null
    }
    const dir = path.dirname(track.path)
    const folder = artwork.folder(dir)
    if (folder) return artworkURL(artwork.folderKey(dir))
    const sibling = artwork.albumCoverSource(songId)
    if (sibling) return artworkURL(sibling)
    return null
  })

  // ----------------------------------------------------------------- lyrics
  ipcMain.handle(IPC.getLyrics, async (_e, songId: string, force = false) => {
    const track = library.getSongById(songId)
    if (!track) return null
    return lyrics.getLyrics(track, force)
  })

  // ----------------------------------------------------------------- providers / search
  ipcMain.handle(IPC.isProviderConfigured, () => {
    const cfg = {
      spotifyClientId: settings.get('spotifyClientId'),
      spotifyClientSecret: settings.get('spotifyClientSecret'),
      youtubeApiKey: settings.get('youtubeApiKey'),
      acoustidApiKey: settings.get('acoustidApiKey')
    }
    return providers.status(cfg)
  })
  ipcMain.handle(
    IPC.search,
    (event, query: string, filters?: SearchFilters, record?: boolean) => {
      analytics.increment(ANALYTICS_KEYS.searchRun)
      const { partial, online } = search.runStreaming(query, filters ?? {}, record === true)
      void online.then((results) => {
        if (!event.sender.isDestroyed()) {
// done: true tells the UI "providers finished" so it can stop
          // waiting — even when nothing was found.
          event.sender.send(IPC.onSearchOnline, { query, online: results, done: true })
        }
      })
      return partial
    }
  )
  ipcMain.handle(IPC.resolveYouTubeStream, (_e, videoId: string, fresh?: boolean) =>
    toResult(() => providers.resolveYouTubeStream(videoId, fresh === true))
  )
  // Engine status is cached in main; "check" re-reads what is installed and asks GitHub for the newest
  // release, "update" installs the newest release (also when it is only "up to date": a broken or
  // system copy is replaced by a verified one).
  ipcMain.handle(IPC.ytEngineInfo, () => ytEngine.status)
  ipcMain.handle(IPC.ytEngineCheck, () => ytEngine.refresh(true))
  ipcMain.handle(IPC.ytEngineUpdate, () => ytEngine.install())
  ipcMain.on(IPC.prefetchYouTubeStreams, (_e, ids: unknown, priority: unknown) => {
    if (Array.isArray(ids)) {
      providers.prefetchYouTubeStreams(
        ids.filter((i): i is string => typeof i === 'string').slice(0, 12),
        priority === true
      )
    }
  })
  ipcMain.handle(IPC.resolveYouTubeStreamBatch, (_e, videoIds: string[]) =>
    toResult(() => providers.resolveYouTubeStreamBatch(videoIds))
  )
  ipcMain.handle(IPC.resolveYouTubeUrl, (_e, url: string) =>
    toResult(() => providers.resolveYouTubeUrl(url))
  )
  ipcMain.handle(IPC.resolvePlaylistEntries, async (_e, url: string) => {
    const cfg = {
      spotifyClientId: settings.get('spotifyClientId'),
      spotifyClientSecret: settings.get('spotifyClientSecret'),
      youtubeApiKey: settings.get('youtubeApiKey'),
      acoustidApiKey: settings.get('acoustidApiKey')
    }
    return providers.resolvePlaylistEntries(url, cfg)
  })
  ipcMain.handle(IPC.downloadYouTubeAudio, (_e, videoId: string) =>
    toResult(() => providers.downloadYouTubeAudio(videoId))
  )
  ipcMain.handle(IPC.openVideoWindow, async (_e, videoId: string) => {
    await windows.openVideoWindow(videoId)
    // Opening the video takes over: pause the app's song, and remember to
    // resume it when the video ends.
    const snap = playback.getSnapshot()
    if (snap.status === 'playing' && snap.songId) {
      windows.noteSongPausedByVideo()
      windows.sendToMain(IPC.onPlaybackCommand, 'pause')
    }
    return true
  })
  ipcMain.handle(IPC.videoPickFolder, async () => {
    const res = await dialog.showOpenDialog({
      title: 'Choose download folder',
      defaultPath: paths.downloadsDir,
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
  })
  ipcMain.handle(
    IPC.videoDownload,
    async (_e, videoId: string, height: number, audio: 'best' | 'm4a' | 'opus', destDir?: string) => {
      const item = await downloads.enqueueYouTubeVideo(videoId, 'YouTube video', {
        height,
        audio,
        destDir: destDir ?? undefined
      })
      if (item) {
        void (async () => {
          const title = await providers.getYouTubeTitle(videoId)
          if (title) downloads.updateTitle(item.id, title)
        })()
      }
      return item ? item.id : null
    }
  )
  ipcMain.handle(IPC.videoFallbackUrl, async (_e, videoId: string) => {
    if (typeof videoId !== 'string' || !videoId) return null
    return providers.resolveYouTubeVideo(videoId)
  })
  ipcMain.handle(
    IPC.videoDownloadSong,
    async (_e, videoId: string, audio: 'best' | 'm4a' | 'opus', destDir?: string) => {
      const item = await downloads.enqueueYouTubeSong(videoId, 'YouTube song', {
        audio,
        destDir: destDir ?? undefined
      })
      if (item) {
        void (async () => {
          const title = await providers.getYouTubeTitle(videoId)
          if (title) downloads.updateTitle(item.id, title)
        })()
      }
      return item ? item.id : null
    }
  )
  ipcMain.handle(IPC.videoRetry, async (_e, videoId: string) => {
    if (typeof videoId !== 'string' || !videoId) return false
    await windows.openVideoWindow(videoId)
    return true
  })
  ipcMain.handle(IPC.getSearchHistory, () => search.history())
  ipcMain.handle(IPC.clearSearchHistory, () => search.clearHistory())
  ipcMain.handle(IPC.removeSearchHistory, (_e, id: string) => search.removeHistoryEntry(id))
  ipcMain.handle(IPC.pinSearch, (_e, id: string) => search.pinHistoryEntry(id, true))
  ipcMain.handle(IPC.unpinSearch, (_e, id: string) => search.pinHistoryEntry(id, false))

  // ----------------------------------------------------------------- playlists
  ipcMain.handle(IPC.getPlaylists, () => playlists.list())
  ipcMain.handle(IPC.getPlaylist, (_e, id: string) => playlists.get(id))
  ipcMain.handle(IPC.getPlaylistEntries, (_e, id: string) => playlists.entries(id))
  ipcMain.handle(IPC.createPlaylist, (_e, input) => playlists.create(input))
  ipcMain.handle(IPC.updatePlaylist, (_e, id, input) => playlists.update(id, input))
  ipcMain.handle(IPC.deletePlaylist, (_e, id: string) => toResult(() => playlists.delete(id)))
  ipcMain.handle(IPC.duplicatePlaylist, (_e, id: string) => playlists.duplicate(id))
  ipcMain.handle(IPC.addToPlaylist, (_e, id: string, songIds: string[]) =>
    toResult(() => playlists.addTracks(id, songIds))
  )
  ipcMain.handle(IPC.removeFromPlaylist, (_e, id: string, songIds: string[]) =>
    toResult(() => playlists.removeTracks(id, songIds))
  )
  ipcMain.handle(IPC.reorderPlaylist, (_e, id: string, orderedIds: string[]) =>
    toResult(() => playlists.reorder(id, orderedIds))
  )
  ipcMain.handle(IPC.togglePlaylistPin, (_e, id: string) => toResult(() => playlists.togglePin(id)))
  ipcMain.handle(IPC.evaluateSmartPlaylist, (_e, id: string) => playlists.evaluateSmartPlaylist(id))

  ipcMain.handle(IPC.importPlaylist, async () => {
    const result = await dialog.showOpenDialog(windows.getMain()!, {
      title: 'Import playlist',
      filters: [{ name: 'Playlists', extensions: ['m3u', 'm3u8'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return playlists.importPlaylist(result.filePaths[0], null)
  })

  ipcMain.handle(IPC.exportPlaylist, async (_e, playlistId: string) => {
    const playlist = playlists.get(playlistId)
    if (!playlist) return false
    const safeName = playlist.name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'playlist'
    const result = await dialog.showSaveDialog(windows.getMain()!, {
      title: 'Export playlist',
      defaultPath: `${safeName}.m3u8`,
      filters: [{ name: 'M3U Playlist', extensions: ['m3u8'] }]
    })
    if (result.canceled || !result.filePath) return false
    return playlists.exportPlaylist(playlistId, result.filePath)
  })

  // ----------------------------------------------------------------- favorites
  ipcMain.handle(IPC.getFavorites, (_e, itemType: string) => favorites.list(itemType))
  ipcMain.handle(IPC.toggleFavorite, (_e, itemType: string, itemId: string) => {
    return favorites.toggle(itemType, itemId)
  })

  // ----------------------------------------------------------------- queue / history
  ipcMain.handle(IPC.getQueue, () => queue.load())
  ipcMain.handle(IPC.saveQueue, (_e, entries) => queue.save(entries))
  ipcMain.handle(IPC.clearQueue, () => queue.clear())
  ipcMain.handle(IPC.getHistory, (_e, limit = 50) => history.recent(limit))
  ipcMain.handle(IPC.clearHistory, () => history.clear())
  // NOTE: IPC.getHistoryBackups / IPC.restoreHistory previously called
  // history.backups() / history.restoreBackup(), which don't exist on
  // HistoryService and aren't called anywhere in the renderer (it only
  // uses the backup:* channels below). Removed as dead/mis-wired code —
  // if you need history-specific backups, implement them on HistoryService
  // and re-add the handlers.

  // Latch so the video is paused only when a song actually starts playing,
  // not on every playback-state tick (timeupdate keeps status 'playing').
  let videoPausedOnSong = false
  // Resume state persistence: nothing ever wrote lastSongId/lastPositionSeconds,
  // so "resume on launch" could never work. Persist the song id whenever it
  // changes and the position when playback stops or at most every 10s.
  let persistedResumeSongId: string | null = null
  let lastResumePosAt = 0
  ipcMain.on(IPC.playbackState, (e, state) => {
    playback.update(state)
    const snap = playback.getSnapshot()
    playback.recordPlayIfNew()
    tray.update(snap)
    const songId = snap.songId
    if (songId && songId !== persistedResumeSongId) {
      persistedResumeSongId = songId
      settings.set('lastSongId', songId)
    }
    const now = Date.now()
    if (songId && (snap.status !== 'playing' || now - lastResumePosAt > 10_000)) {
      lastResumePosAt = now
      settings.set('lastPositionSeconds', Math.round(snap.currentTime))
    }
    if (snap.status === 'playing' && snap.songId && !videoPausedOnSong) {
      videoPausedOnSong = true
      windows.pauseVideo()
    } else if (snap.status !== 'playing') {
      videoPausedOnSong = false
    }
    // Echo to other windows only (mini player syncs this way)
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.webContents !== e.sender) {
        win.webContents.send(IPC.playbackState, playback.toPlaybackState())
      }
    }
  })
  ipcMain.handle(IPC.getPlaybackState, () => playback.toPlaybackState())

  ipcMain.on(IPC.commandPlayback, (_e, command: string) => {
    const sender = _e.sender
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.webContents !== sender) {
        win.webContents.send(IPC.onPlaybackCommand, command)
      }
    }
  })

  // ----------------------------------------------------------------- downloads
  ipcMain.handle(IPC.getDownloads, () => downloads.list())
  ipcMain.handle(IPC.enqueueDownload, async (_e, url: string, title: string) => {
    const item = await downloads.enqueue(url, title)
    return item
  })
  ipcMain.handle(
    IPC.enqueuePlaylist,
    async (_e, url: string, audio?: 'best' | 'm4a' | 'opus', destDir?: string) => {
      if (typeof url !== 'string' || !url.trim()) return { found: 0, enqueued: 0 }
      return downloads.enqueuePlaylist(url.trim(), {
        audio,
        destDir: destDir ?? undefined
      })
    }
  )
  ipcMain.handle(
    IPC.enqueueEntries,
    async (
      _e,
      entries: unknown,
      opts?: { mode?: string; audio?: string; height?: number; destDir?: string | null }
    ) => {
      if (!Array.isArray(entries)) return { found: 0, enqueued: 0 }
      const clean = entries
        .filter(
          (x): x is {
            videoId: string
            title: string
            duration?: number
            track?: { name: string; artists: string[]; album: string | null; durationMs: number | null }
          } => Boolean(x) && typeof x.videoId === 'string' && typeof x.title === 'string'
        )
        .slice(0, 2000)
        .map((x) => ({
          videoId: x.videoId,
          title: x.title,
          duration: typeof x.duration === 'number' ? x.duration : undefined,
          // Spotify entries carry the exact source track (better tags).
          track:
            x.track && typeof x.track.name === 'string' && Array.isArray(x.track.artists)
              ? x.track
              : undefined
        }))
      const audio = opts?.audio === 'm4a' || opts?.audio === 'opus' ? opts.audio : 'best'
      return downloads.enqueueEntries(clean, {
        mode: opts?.mode === 'video' ? 'video' : 'song',
        audio,
        height: Number.isFinite(Number(opts?.height)) ? Number(opts?.height) : 0,
        destDir: opts?.destDir ? String(opts.destDir) : undefined
      })
    }
  )
  ipcMain.handle(IPC.pauseDownload, (_e, id: string) => downloads.pause(id))
  ipcMain.handle(IPC.resumeDownload, (_e, id: string) => downloads.resume(id))
  ipcMain.handle(IPC.cancelDownload, (_e, id: string) => downloads.cancel(id))
  ipcMain.handle(IPC.retryDownload, (_e, id: string) => downloads.retry(id))
  ipcMain.handle(IPC.pauseAllDownload, () => downloads.pauseAll())
  ipcMain.handle(IPC.resumeAllDownload, () => downloads.resumeAll())
  ipcMain.handle(IPC.removeDownload, (_e, id: string, deleteFile?: boolean) =>
    downloads.remove(id, deleteFile === true)
  )
  ipcMain.handle(IPC.clearCompleted, () => downloads.clearCompleted())
  ipcMain.handle(IPC.clearPending, () => downloads.clearPending())
  ipcMain.handle(IPC.revealDownload, (_e, id: string) => {
    const file = downloads.reveal(id)
    if (file) shell.showItemInFolder(file)
    return Boolean(file)
  })
  ipcMain.handle(IPC.openDownloadsFolder, () => shell.openPath(paths.downloadsDir))

  // ----------------------------------------------------------------- internet archive
  ipcMain.handle(IPC.archiveSearch, (_e, text: unknown, page?: unknown, losslessOnly?: unknown) =>
    archive.search(
      typeof text === 'string' ? text.slice(0, 200) : '',
      Number.isFinite(Number(page)) ? Number(page) : 1,
      losslessOnly !== false
    )
  )
  ipcMain.handle(IPC.archiveItem, (_e, identifier: unknown) => archive.getItem(identifier as string))
  ipcMain.handle(
    IPC.archiveEnqueue,
    async (_e, identifier: unknown, fileNames: unknown, destDir?: unknown) => {
      if (!isValidIdentifier(identifier) || !Array.isArray(fileNames)) return { found: 0, enqueued: 0 }
      // Only files that the item really lists can be queued (the renderer never
      // supplies a URL), and the item's own title names the folder.
      const item = await archive.getItem(identifier)
      const wanted = new Set(fileNames.filter((n): n is string => typeof n === 'string').slice(0, 500))
      const chosen = item.files.filter((f) => wanted.has(f.name))
      let enqueued = 0
      for (const f of chosen) {
        const coverData = await archive.getCover(item, f.name)
        const row = await downloads.enqueueFile(buildDownloadUrl(identifier, f.name), {
          title: f.title ?? f.name.replace(/\.[^.]+$/, ''),
          fileName: f.name.split('/').pop() ?? f.name,
          folder: item.title || identifier,
          destDir: typeof destDir === 'string' && destDir.trim() ? destDir : undefined,
          md5: f.md5,
          // Fill only what the file lacks: its own tags, then the item's.
          tags: {
            title: f.title ?? f.name.split('/').pop()?.replace(/\.[^.]+$/, '').replace(/_/g, ' '),
            artist: f.artist ?? item.creator,
            album: f.album ?? item.title,
            track: f.track,
            date: item.date,
            genre: f.genre,
            cover: coverData
          }
        })
        if (row) enqueued++
      }
      return { found: chosen.length, enqueued }
    }
  )

  // ----------------------------------------------------------------- backup
  ipcMain.handle(IPC.createBackup, () => backup.create())
  ipcMain.handle(IPC.listBackups, () => backup.list())
  ipcMain.handle(IPC.restoreBackup, async () => {
    const result = await dialog.showOpenDialog(windows.getMain()!, {
      title: 'Restore library backup',
      filters: [{ name: 'SQLite backup', extensions: ['sqlite'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return false
    const ok = await backup.restore(result.filePaths[0])
    if (ok) {
      // An older backup may predate schema changes: bring it up to date.
      runMigrations(db)
      settings.load()
      library.rebuildAggregates()
      windows.broadcast(IPC.onLibraryChanged, library.getStats())
    }
    return ok
  })
  ipcMain.handle(IPC.exportLibrary, async () => {
    const result = await dialog.showSaveDialog(windows.getMain()!, {
      title: 'Export library',
      defaultPath: `Oli-library-backup-${new Date().toISOString().slice(0, 10)}.sqlite`,
      filters: [{ name: 'SQLite database', extensions: ['sqlite'] }]
    })
    if (result.canceled || !result.filePath) return false
    try {
      const bytes = db.exportBytes()
      fs.writeFileSync(result.filePath, Buffer.from(bytes))
      return true
    } catch (err) {
      getLogger().error('Library export failed', err)
      return false
    }
  })
  ipcMain.handle(IPC.importLibrary, async () => {
    const result = await dialog.showOpenDialog(windows.getMain()!, {
      title: 'Import library',
      filters: [{ name: 'SQLite database', extensions: ['sqlite'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return false
    const ok = await backup.restore(result.filePaths[0])
    if (ok) {
      // An older backup may predate schema changes: bring it up to date.
      runMigrations(db)
      settings.load()
      library.rebuildAggregates()
      windows.broadcast(IPC.onLibraryChanged, library.getStats())
    }
    return ok
  })

  // ----------------------------------------------------------------- metadata ops
  ipcMain.handle(IPC.refreshMetadata, (_e, songId: string) => metadataOps.refreshSong(songId))
  ipcMain.handle(IPC.editMetadata, (_e, songId: string, edits: unknown) =>
    toResult(() => metadataOps.applySongEdits(songId, edits as never))
  )

  // ----------------------------------------------------------------- updates
  ipcMain.handle(IPC.checkForUpdates, (_e, auto = false) => updater.check(auto))
  ipcMain.on(IPC.openReleasePage, (_e, url: string | null) => updater.openReleasePage(url))
}

function artworkURL(songId: string): string {
  return `cyttos-art://artwork/${encodeURIComponent(songId)}`
}

function applyRuntimeSettings(services: ServiceContainer): void {
  const { settings, windows, tray } = services
  process.env['CYTTO_CLOSE_TO_TRAY'] = settings.getBoolean('closeToTray') ? '1' : '0'
  try {
    windows.setTaskbarProgress(0, settings.getBoolean('taskbarProgressEnabled'))
  } catch {
    // ignore
  }
  try {
    windows.applyMiniSettings()
  } catch {
    // ignore
  }
  try {
    windows.applyWindowTheme()
  } catch {
    // ignore
  }
  // The "Show tray icon" toggle only took effect after a restart.
  try {
    if (settings.getBoolean('showTrayIcon')) tray.create()
    else tray.destroy()
  } catch {
    // ignore
  }
}
