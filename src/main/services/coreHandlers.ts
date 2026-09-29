import { ANALYTICS_KEYS } from '@shared/constants'
import { IPC } from '@shared/ipc'
import type { AppSettings, SearchFilters } from '@shared/types'
import type { AnalyticsService } from './analytics'
import type { FavoritesService } from './favorites'
import type { LibraryQueries } from './libraryQueries'
import type { LyricsService } from './lyrics'
import type { PlaylistService } from './playlists'
import type { HistoryService, PlaybackStateStore, QueueService } from './playerState'
import type { SearchProviders, SearchService } from './search'
import type { SettingsStore } from './settingsStore'

/**
 * The answers to the app's "database side" IPC channels: settings, library reads, playlists, favorites, queue,
 * history, playback state, local search and lyrics. They depend only on the shared services, so the Android app
 * (which has no Electron main process) serves them from here. The desktop `ipc.ts` still registers the same
 * channels itself; keep the two in step when a channel changes.
 */
export interface CoreServices {
  settings: SettingsStore
  library: LibraryQueries
  playlists: PlaylistService
  favorites: FavoritesService
  playback: PlaybackStateStore
  queue: QueueService
  history: HistoryService
  analytics: AnalyticsService
  search: SearchService
  lyrics: LyricsService
  providers: SearchProviders & { status(config: Record<string, string>): unknown }
}

export type ChannelHandler = (...args: never[]) => unknown

/** `emit` sends an event to the UI (like webContents.send on desktop). */
export function buildCoreHandlers(
  s: CoreServices,
  emit: (channel: string, payload: unknown) => void
): Record<string, ChannelHandler> {
  // Same behaviour as the desktop toResult(): an error becomes null instead of a rejected promise.
  const safe =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R | null => {
      try {
        return fn(...args)
      } catch (err) {
        console.error('[core] handler failed', err)
        return null
      }
    }

  const providerConfig = (): Record<string, string> => ({
    spotifyClientId: s.settings.get('spotifyClientId'),
    spotifyClientSecret: s.settings.get('spotifyClientSecret'),
    youtubeApiKey: s.settings.get('youtubeApiKey'),
    acoustidApiKey: s.settings.get('acoustidApiKey')
  })

  // Resume state: remember the song when it changes and the position when playback stops or every 10 s.
  let persistedResumeSongId: string | null = null
  let lastResumePosAt = 0

  const h: Record<string, (...args: never[]) => unknown> = {
    // settings
    [IPC.getSettings]: () => s.settings.all(),
    [IPC.setSettings]: ((patch: Partial<AppSettings>) => {
      s.settings.setMany(patch ?? {})
      emit(IPC.onSettingsChanged, patch)
      return s.settings.all()
    }) as (...args: never[]) => unknown,

    // library (reads)
    [IPC.getLibrary]: () => s.library.getFolders(),
    [IPC.getSongs]: ((q?: Record<string, unknown>) => s.library.querySongs(q ?? {})) as never,
    [IPC.getSongById]: ((id: string) => s.library.getSongById(id)) as never,
    [IPC.getAlbums]: () => s.library.getAlbums(),
    [IPC.getAlbumById]: ((id: string) => s.library.getAlbumById(id)) as never,
    [IPC.getAlbumSongs]: ((id: string) => s.library.getAlbumSongs(id)) as never,
    [IPC.getArtists]: () => s.library.getArtists(),
    [IPC.getArtistById]: ((id: string) => s.library.getArtistById(id)) as never,
    [IPC.getArtistAlbums]: ((id: string) => s.library.getArtistAlbums(id)) as never,
    [IPC.getArtistSongs]: ((id: string) => s.library.getArtistSongs(id)) as never,
    [IPC.mergeAlbums]: safe((canonicalId: string, aliasIds: string[]) => s.library.mergeAlbums(canonicalId, aliasIds)) as never,
    [IPC.mergeArtists]: safe((canonicalId: string, aliasIds: string[]) => s.library.mergeArtists(canonicalId, aliasIds)) as never,
    [IPC.getGenres]: () => s.library.getGenres(),
    [IPC.getGenreSongs]: ((g: string) => s.library.getGenreSongs(g)) as never,
    [IPC.getSimilarTracks]: ((songId: string, excludeIds: string[], limit?: number) =>
      s.library.getSimilarTracks(songId, excludeIds, limit)) as never,
    [IPC.getComposers]: () => s.library.getComposers(),
    [IPC.getComposerSongs]: ((c: string) => s.library.getComposerSongs(c)) as never,
    [IPC.getStats]: () => s.library.getStats(),

    // playlists
    [IPC.getPlaylists]: () => s.playlists.list(),
    [IPC.getPlaylist]: ((id: string) => s.playlists.get(id)) as never,
    [IPC.getPlaylistEntries]: ((id: string) => s.playlists.entries(id)) as never,
    [IPC.createPlaylist]: ((input: never) => s.playlists.create(input)) as never,
    [IPC.updatePlaylist]: ((id: string, input: never) => s.playlists.update(id, input)) as never,
    [IPC.deletePlaylist]: safe((id: string) => s.playlists.delete(id)) as never,
    [IPC.duplicatePlaylist]: ((id: string) => s.playlists.duplicate(id)) as never,
    [IPC.addToPlaylist]: safe((id: string, songIds: string[]) => s.playlists.addTracks(id, songIds)) as never,
    [IPC.removeFromPlaylist]: safe((id: string, songIds: string[]) => s.playlists.removeTracks(id, songIds)) as never,
    [IPC.reorderPlaylist]: safe((id: string, orderedIds: string[]) => s.playlists.reorder(id, orderedIds)) as never,
    [IPC.togglePlaylistPin]: safe((id: string) => s.playlists.togglePin(id)) as never,
    [IPC.evaluateSmartPlaylist]: ((id: string) => s.playlists.evaluateSmartPlaylist(id)) as never,

    // favorites
    [IPC.getFavorites]: ((itemType: string) => s.favorites.list(itemType)) as never,
    [IPC.toggleFavorite]: ((itemType: string, itemId: string) => s.favorites.toggle(itemType, itemId)) as never,

    // queue / history / playback state
    [IPC.getQueue]: () => s.queue.load(),
    [IPC.saveQueue]: ((entries: never) => s.queue.save(entries)) as never,
    [IPC.clearQueue]: () => s.queue.clear(),
    [IPC.getHistory]: ((limit = 50) => s.history.recent(limit)) as never,
    [IPC.clearHistory]: () => s.history.clear(),
    [IPC.getPlaybackState]: () => s.playback.toPlaybackState(),
    [IPC.playbackState]: ((state: never) => {
      s.playback.update(state)
      const snap = s.playback.getSnapshot()
      s.playback.recordPlayIfNew()
      const songId = snap.songId
      if (songId && songId !== persistedResumeSongId) {
        persistedResumeSongId = songId
        s.settings.set('lastSongId', songId)
      }
      const now = Date.now()
      if (songId && (snap.status !== 'playing' || now - lastResumePosAt > 10_000)) {
        lastResumePosAt = now
        s.settings.set('lastPositionSeconds', Math.round(snap.currentTime))
      }
      return null
    }) as never,

    // search (local library; online providers come from `providers`)
    [IPC.isProviderConfigured]: () => s.providers.status(providerConfig()),
    [IPC.search]: ((query: string, filters?: SearchFilters, record?: boolean) => {
      s.analytics.increment(ANALYTICS_KEYS.searchRun)
      const { partial, online } = s.search.runStreaming(query, filters ?? {}, record === true)
      void online.then((results) => emit(IPC.onSearchOnline, { query, online: results, done: true }))
      return partial
    }) as never,
    [IPC.getSearchHistory]: () => s.search.history(),
    [IPC.clearSearchHistory]: () => s.search.clearHistory(),
    [IPC.removeSearchHistory]: ((id: string) => s.search.removeHistoryEntry(id)) as never,
    [IPC.pinSearch]: ((id: string) => s.search.pinHistoryEntry(id, true)) as never,
    [IPC.unpinSearch]: ((id: string) => s.search.pinHistoryEntry(id, false)) as never,

    // lyrics
    [IPC.getLyrics]: (async (songId: string, force = false) => {
      const track = s.library.getSongById(songId)
      return track ? s.lyrics.getLyrics(track, force) : null
    }) as never
  }
  return h
}
