export const APP_NAME = 'Oli'
export const APP_NAME_COMPACT = 'Oli'
export const APP_VERSION = '1.0.0'
export const APP_ID = 'com.cyttos.oli'

export const MAIN_WINDOW = 'main'
export const MINI_WINDOW = 'mini'

export const AUDIO_EXTENSIONS = [
  '.flac',
  '.mp3',
  '.wav',
  '.aiff',
  '.aif',
  '.m4a',
  '.aac',
  '.mp4',
  '.ogg',
  '.oga',
  '.opus',
  '.wma',
  '.webm',
  '.mp2',
  '.ape',
  '.wv',
  '.mka'
] as const

/** Formats Chromium/HTMLAudio can actually decode (FLAC is first-class). */
export const NATIVELY_PLAYABLE = new Set([
  'flac',
  'mp3',
  'wav',
  'aiff',
  'aif',
  'm4a',
  'aac',
  'ogg',
  'oga',
  'opus',
  'webm'
])

/**
 * Codecs Chromium's audio element cannot decode on this platform (e.g. opus in
 * .opus containers, wavpack, ape). Files with these codecs are pre-transcoded
 * to MP3 during/after scans so playback starts instantly.
 */
export const NEEDS_TRANSCODE_CODECS = new Set([
  'opus',
  'wavpack',
  'ape',
  'dsd',
  'ac3',
  'eac3',
  'dts',
  'mlp',
  'truehd',
  'tta',
  'tak',
  'wmalossless',
  'wmapro',
  'wma'
])

/** Extension fallback for files whose codec could not be identified. */
export const NEEDS_TRANSCODE_EXTS = new Set([
  '.opus',
  '.wv',
  '.ape',
  '.wma',
  '.mka',
  '.dsf',
  '.dff',
  '.tta',
  '.tak'
])

/** True when a local file likely cannot be decoded by the audio element. */
export function needsTranscodeFor(codec: string | null | undefined, filePath: string): boolean {
  const lower = (codec ?? '').toLowerCase()
  if (lower && NEEDS_TRANSCODE_CODECS.has(lower)) return true
  return NEEDS_TRANSCODE_EXTS.has(filePath.slice(filePath.lastIndexOf('.')).toLowerCase())
}

export const FOLDER_ARTWORK_NAMES = [
  'cover.jpg',
  'cover.png',
  'folder.jpg',
  'folder.png',
  'album.jpg',
  'album.png',
  'front.jpg',
  'front.png',
  'AlbumArt.jpg',
  'AlbumArtSmall.jpg',
  'cover.jpeg',
  'folder.jpeg',
  'album.jpeg',
  'front.jpeg'
]

export const ARTWORK_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']

export const DEFAULT_SETTINGS = {
  themeMode: 'dark',
  accentColor: null,
  accentFromArtwork: true,
  reduceMotion: false,
  crossfadeSeconds: 0,
  replayGainMode: 'off',
  volume: 0.8,
  playbackSpeed: 1,
  preservePitch: true,
  shuffle: false,
  repeat: 'off',
  resumeOnLaunch: true,
  showTrayIcon: true,
  minimizeToTray: true,
  closeToTray: false,
  mediaKeysEnabled: true,
  taskbarProgressEnabled: true,
  miniPlayerAlwaysOnTop: true,
  miniPlayerTaskbar: false,
  miniPlayerOpacity: 0.5,
  bubblePosition: null,
  notificationsEnabled: true,
  cacheArtworkMB: 512,
  scanOnLaunch: true,
  watchFolders: true,
  autoUpdateEnabled: true,
  telemetryLocal: true,
  equalizer: {
    enabled: false,
    preset: 'flat',
    preamp: 0,
    bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  },
  language: 'en',
  lyricsOnline: 'enabled',
  spotifyClientId: '',
  spotifyClientSecret: '',
  youtubeApiKey: '',
  acoustidApiKey: '',
  songsAhead: 3,
  ytConcurrency: 1,
  lastPage: '/',
  lastSongId: null,
  lastPositionSeconds: 0
} as const

export const EQ_PRESETS: Record<string, { name: string; bands: number[]; preamp: number }> = {
  flat: { name: 'Flat', bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], preamp: 0 },
  bass: { name: 'Bass Boost', bands: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0], preamp: 0 },
  treble: { name: 'Treble Boost', bands: [0, 0, 0, 0, 0, 0, 2, 3, 5, 6], preamp: 0 },
  vocal: { name: 'Vocal', bands: [-2, -1, 1, 3, 4, 4, 3, 1, -1, -2], preamp: 0 },
  rock: { name: 'Rock', bands: [4, 3, 1, -1, -1, 1, 2, 3, 4, 4], preamp: 0 },
  jazz: { name: 'Jazz', bands: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3], preamp: 0 },
  classical: { name: 'Classical', bands: [3, 2, 0, -1, -2, -2, -1, 0, 2, 3], preamp: 0 },
  dance: { name: 'Dance', bands: [5, 4, 2, 1, 0, 0, 1, 2, 3, 4], preamp: 0 },
  electronic: { name: 'Electronic', bands: [4, 3, 1, 0, 1, 2, 1, 0, 1, 2], preamp: 0 }
}

export const EQ_BAND_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]

export const FORMAT_LABELS: Record<string, string> = {
  flac: 'FLAC',
  mp3: 'MP3',
  wav: 'WAV',
  aiff: 'AIFF',
  aif: 'AIFF',
  m4a: 'AAC',
  aac: 'AAC',
  ogg: 'OGG',
  oga: 'OGG',
  opus: 'Opus',
  wma: 'WMA',
  webm: 'WebM'
}

export const STORAGE_LIMIT_WARN = 0.9

export const DEFAULT_ARTWORK_COLORS = {
  fallbackA: '#7c3aed',
  fallbackB: '#db2777'
}

export const ANALYTICS_KEYS = {
  appLaunches: 'app.launches',
  songsPlayed: 'stats.songs.played',
  secondsPlayed: 'stats.seconds.played',
  scansRun: 'stats.scans.run',
  tracksAdded: 'stats.tracks.added',
  downloadsCompleted: 'stats.downloads.completed',
  searchRun: 'stats.search.run',
  favoritesToggled: 'stats.favorites.toggled'
} as const
