import * as path from 'node:path'
import { app } from 'electron'

export interface AppPaths {
  userData: string
  databaseFile: string
  logsDir: string
  artworkCacheDir: string
  thumbnailCacheDir: string
  waveformCacheDir: string
  providerCacheDir: string
  downloadsDir: string
  backupsDir: string
}

export function resolveAppPaths(): AppPaths {
  const userData = app.getPath('userData')
  return {
    userData,
    databaseFile: path.join(userData, 'library.sqlite'),
    logsDir: path.join(userData, 'logs'),
    artworkCacheDir: path.join(userData, 'cache', 'artwork'),
    thumbnailCacheDir: path.join(userData, 'cache', 'thumbnails'),
    waveformCacheDir: path.join(userData, 'cache', 'waveforms'),
    providerCacheDir: path.join(userData, 'cache', 'providers'),
    downloadsDir: path.join(app.getPath('downloads'), 'Oli Downloads'),
    backupsDir: path.join(userData, 'backups')
  }
}
