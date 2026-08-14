import { app } from 'electron'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { IPC } from '@shared/ipc'
import { APP_NAME } from '@shared/constants'
import { initLogger, getLogger, errorOf } from './services/logger'
import { resolveAppPaths } from './paths'
import { Database } from './services/database'
import { runMigrations } from './services/migrations'
import { SettingsStore } from './services/settingsStore'
import { ArtworkService } from './services/artwork'
import { LyricsService } from './services/lyrics'
import { LibraryService } from './services/library'
import { SearchService } from './services/search'
import { FavoritesService } from './services/favorites'
import { PlaylistService } from './services/playlists'
import { PlaybackStateStore, QueueService, HistoryService } from './services/playerState'
import { TranscodeService } from './services/transcode'
import { DownloadService } from './services/downloads'
import { BackupService } from './services/backup'
import { UpdaterService } from './services/updater'
import { AnalyticsService } from './services/analytics'
import { NotificationService } from './services/notifications'
import { MetadataOpsService } from './services/metadataOps'
import { MetaFixService } from './services/metaFix'
import { ProviderService } from './services/provider'
import { WindowManager } from './windows'
import { TrayManager } from './tray'
import { registerIpc, type ServiceContainer } from './ipc'
import {
  declareCustomSchemes,
  registerArtworkProtocol,
  registerLocalProtocol,
  registerVendorProtocol
} from './protocol'
import { markQuitting } from './appState'
import { importLegacyData } from './services/legacyImport'

declareCustomSchemes()

// The app was renamed from "Cytto's Play" to "Oil" and then to "Oli", which
// changes the userData directory each time. Move the existing data once so
// the library, settings and queue survive the rename; a fresh folder is
// created otherwise. The copy goes through a temp file so an interrupted
// copy can never leave a truncated library.sqlite behind (a truncated file
// fails the integrity check and triggers an empty-database reinit).
function getLegacyUserDirs(): string[] {
  return [
    path.join(app.getPath('appData'), "Cytto's Play"),
    path.join(app.getPath('appData'), 'Oil')
  ]
}
{
  const newUserData = app.getPath('userData')
  const legacyDirs = getLegacyUserDirs()
  for (const legacyDir of legacyDirs) {
    if (legacyDir === newUserData || !fs.existsSync(legacyDir)) continue
    try {
      const legacyDb = path.join(legacyDir, 'library.sqlite')
      const newDb = path.join(newUserData, 'library.sqlite')
      if (!fs.existsSync(newUserData)) {
        fs.renameSync(legacyDir, newUserData)
      } else if (fs.existsSync(legacyDb) && !fs.existsSync(newDb)) {
        const tmp = `${newDb}.copy-tmp`
        fs.copyFileSync(legacyDb, tmp)
        fs.renameSync(tmp, newDb)
      }
    } catch (err) {
      getLogger().warn('Failed to migrate user data from legacy directory', errorOf(err))
    }
  }
}

// A single uncaught async error (stream teardown race, third-party hiccup)
// must never take the whole app down. Log it and keep going.
process.on('uncaughtException', (err) => {
  try {
    getLogger().error('Uncaught exception', errorOf(err))
  } catch {
    console.error('Uncaught exception', err)
  }
})
process.on('unhandledRejection', (reason) => {
  try {
    getLogger().error('Unhandled rejection', errorOf(reason))
  } catch {
    console.error('Unhandled rejection', reason)
  }
})

const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  app.quit()
} else {
  let db: Database
  let settings: SettingsStore
  let serviceContainer: ServiceContainer | null = null

  app.on('second-instance', () => {
    serviceContainer?.windows.showMain()
  })

  // Forward renderer console output into the app log so playback problems
  // (audio element errors, fallback switches) are visible from the log file.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('console-message', (ev: unknown, ...rest: unknown[]) => {
      let line = ''
      if (rest.length >= 2) {
        line = `[renderer:${String(rest[0])}] ${String(rest[1])}`
      } else if (
        ev &&
        typeof ev === 'object' &&
        'message' in (ev as { message?: unknown })
      ) {
        const d = ev as { level?: unknown; message?: unknown; lineNumber?: unknown; sourceId?: unknown }
        line = `[renderer:${String(d.level)}] ${String(d.message)} (${String(d.sourceId)}:${String(d.lineNumber)})`
      }
      if (line) getLogger().info(line)
    })
  })

  app.whenReady()
    .then(createApp)
    .catch((err) => {
      try {
        getLogger().error(`Failed to start application: ${errorOf(err)}`)
      } catch {
        // logger not yet initialized
      }
      setTimeout(() => app.quit(), 800)
    })

  async function createApp(): Promise<void> {
    const paths = resolveAppPaths()
    initLogger(paths.logsDir, (process.env['CYTTO_LOG_LEVEL'] as 'debug' | 'info' | 'warn' | 'error') ?? 'info')
    const log = getLogger()
    log.info(`${APP_NAME} ${app.getVersion()} starting`)

// ------------------------------------------------------------ database
    db = new Database({ file: paths.databaseFile })
    await db.init()
    await runMigrations(db)
    // One-time merge of anything lost when the Oli database was reinitialized
    // empty (see legacyImport.ts). Runs before settings.load() so restored
    // settings (theme, resume state, ...) are picked up immediately.
    await importLegacyData(db, getLegacyUserDirs())
    log.info('Database ready')

    settings = new SettingsStore(db)
    settings.load()
    process.env['CYTTO_CLOSE_TO_TRAY'] = settings.getBoolean('closeToTray') ? '1' : '0'

    // ------------------------------------------------------------ services
    const artwork = new ArtworkService(db, paths.artworkCacheDir)
    artwork.ensure()
    registerArtworkProtocol(artwork)
    registerLocalProtocol()
    registerVendorProtocol()

    const transcode = new TranscodeService()
    const library = new LibraryService(db, artwork, transcode)
    const lyrics = new LyricsService(db, () => settings.get('lyricsOnline') === 'enabled')
    const providers = new ProviderService(db)
    const search = new SearchService(db, providers, settings)
    const favorites = new FavoritesService(db)
    const playlists = new PlaylistService(db)
    const playback = new PlaybackStateStore(db)
    const queue = new QueueService(db)
    const history = new HistoryService(db)
    const downloads = new DownloadService(db, paths.downloadsDir, {
      downloadYouTubeVideo: (videoId, destDir, opts) =>
        providers.downloadYouTubeVideo(videoId, destDir, opts),
      getYouTubeTitle: (videoId) => providers.getYouTubeTitle(videoId),
      forceKillYouTube: (videoId) => providers.forceKillYtChild(videoId),
      whenYtChildGone: (videoId, maxWaitMs) => providers.whenYtChildGone(videoId, maxWaitMs),
      ytChildRunning: (videoId) => providers.isYtChildRunning(videoId),
      downloadYouTubeAudioFile: (videoId, destDir, opts) =>
        providers.downloadYouTubeAudioFile(videoId, destDir, opts),
      tagYouTubeAudioFile: (filePath, videoId, meta) =>
        providers.tagYouTubeAudioFile(filePath, videoId, meta),
      getYouTubeMeta: (videoId) => providers.getYouTubeMeta(videoId),
      resolveTrackMeta: (videoId, title, durationSec, fresh) =>
        providers.resolveTrackMeta(videoId, title, durationSec, {
          spotifyClientId: settings.get('spotifyClientId'),
          spotifyClientSecret: settings.get('spotifyClientSecret'),
          youtubeApiKey: settings.get('youtubeApiKey'),
          acoustidApiKey: settings.get('acoustidApiKey')
        }, fresh),
      resolvePlaylistEntries: (url) =>
        providers.resolvePlaylistEntries(url, {
          spotifyClientId: settings.get('spotifyClientId'),
          spotifyClientSecret: settings.get('spotifyClientSecret'),
          youtubeApiKey: settings.get('youtubeApiKey'),
          acoustidApiKey: settings.get('acoustidApiKey')
        })
    }, {
      songsAhead: () => Math.min(5, Math.max(1, Number(settings.get('songsAhead')) || 3)),
      ytConcurrency: () => Math.min(3, Math.max(1, Number(settings.get('ytConcurrency')) || 1))
    })
    void downloads.start()
    const backup = new BackupService(db, paths.backupsDir)
    const updater = new UpdaterService()
    const analytics = new AnalyticsService(db)
    const notifications = new NotificationService()
    const metadataOps = new MetadataOpsService(db, library, artwork)
    const metaFix = new MetaFixService(db, providers, library, metadataOps, () => ({
      spotifyClientId: settings.get('spotifyClientId'),
      spotifyClientSecret: settings.get('spotifyClientSecret'),
      youtubeApiKey: settings.get('youtubeApiKey'),
      acoustidApiKey: settings.get('acoustidApiKey')
    }))

    const boundsStore = {
      load: () => loadWindowBounds(db),
      save: (bounds: unknown) => saveWindowBounds(db, bounds as { x: number; y: number; width: number; height: number; maximized: boolean })
    }

    const windows = new WindowManager(boundsStore, settings, providers)
    const tray = new TrayManager({
      playPause: () => windows.sendToMain(IPC.onPlaybackCommand, 'playPause'),
      next: () => windows.sendToMain(IPC.onPlaybackCommand, 'next'),
      previous: () => windows.sendToMain(IPC.onPlaybackCommand, 'previous'),
      show: () => {
        windows.showMain()
      }
    })

    serviceContainer = {
      db,
      settings,
      library,
      artwork,
      lyrics,
      providers,
      search,
      playlists,
      favorites,
      playback,
      queue,
      history,
      downloads,
      backup,
      updater,
      analytics,
      notifications,
      metadataOps,
      metaFix,
      transcode,
      windows,
      tray,
      paths
    }

    registerIpc(serviceContainer)

    // ---------------------------------------------------------- event wiring
    library.on('scan-progress', (p) => windows.broadcast(IPC.onScanProgress, p))
    library.on('library-changed', () => {
      windows.broadcast(IPC.onLibraryChanged, library.getStats())
    })
    downloads.on('changed', () => {
      windows.broadcast(IPC.onDownloadsChanged, downloads.list())
    })
    metaFix.on('progress', (p) => {
      windows.broadcast(IPC.onMetaFixProgress, p)
    })

    // ---------------------------------------------------------- windows
    windows.createMainWindow()

    windows.setThumbarButtons({
      onPrev: () => windows.sendToMain(IPC.onPlaybackCommand, 'previous'),
      onPlayPause: () => windows.sendToMain(IPC.onPlaybackCommand, 'playPause'),
      onNext: () => windows.sendToMain(IPC.onPlaybackCommand, 'next')
    })

    // ---------------------------------------------------------- runtime
    const firstRun = db.count('SELECT id FROM library_locations') === 0
    analytics.incrementLaunch()

    if (settings.getBoolean('showTrayIcon')) tray.create()
    if (settings.getBoolean('watchFolders')) library.startWatchers()
    if (settings.getBoolean('scanOnLaunch')) {
      setTimeout(() => {
        void library.scanLibrary(undefined, false)
      }, 1200)
    }

    // Automatic update check (informational only).
    if (settings.getBoolean('autoUpdateEnabled')) {
      void updater.check(true).then((result) => {
        if (result.updateAvailable) {
          windows.broadcast(IPC.onUpdateStatus, result)
          notifications.showUpdateAvailable(result.latestVersion ?? '', result.updateUrl ?? '')
        }
      })
    }

    // Artwork cache housekeeping.
    setTimeout(() => {
      artwork.cleanup(settings.get('cacheArtworkMB'))
    }, 30_000)

    // Periodic library snapshot for crash recovery.
    setInterval(() => {
      if (db.isDirty) db.flushToDisk()
    }, 60_000).unref?.()

    if (firstRun) {
      setTimeout(() => {
        notifications.show({
          title: APP_NAME,
          body: 'Welcome. Add your music folders in Settings â†’ Library.'
        })
      }, 4000)
    }

    app.on('before-quit', async (event) => {
      if (app.isQuitting) {
        return
      }
      event.preventDefault()
      markQuitting()
      try {
        await db.close()
      } catch (err) {
        log.error('Database close failed', err)
      }
      app.exit(0)
    })
  }

  app.on('window-all-closed', () => {
    // On Windows the app keeps running in the tray / mini player.
  })
}

function loadWindowBounds(db: Database): { x?: number; y?: number; width?: number; height?: number; maximized?: boolean } | null {
  try {
    const row = db.get<{ value: string }>(
      'SELECT value FROM application_state WHERE key = ?',
      ['window.bounds']
    )
    return row ? (JSON.parse(row.value) as { x?: number; y?: number; width?: number; height?: number; maximized?: boolean }) : null
  } catch {
    return null
  }
}

function saveWindowBounds(db: Database, bounds: { x: number; y: number; width: number; height: number; maximized: boolean }): void {
  try {
    db.run(
      `INSERT INTO application_state (key, value) VALUES ('window.bounds', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [JSON.stringify(bounds)]
    )
  } catch {
    // ignored
  }
}
