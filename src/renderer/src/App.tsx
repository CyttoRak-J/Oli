import { useEffect, useState } from 'react'
import { Routes, Route, useLocation, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import * as Tooltip from '@radix-ui/react-tooltip'
import { IPC } from '@shared/ipc'
import { windowControl } from './lib/ipc'
import { bumpArtworkRevision } from './lib/artwork'
import { usePlayer, resumePlayback, applyAudioSettings } from './store/player'
import { usePanels, type PanelKind } from './store/panels'
import { useSettings } from './store/settings'
import { useGlobalShortcuts } from './lib/useGlobalShortcuts'
import { ShortcutsPanel } from './components/ShortcutsPanel'
import { TitleBar } from './components/TitleBar'
import { YtEngineBanner } from './components/YtEngineBanner'
import { MobileNav } from './components/MobileNav'
import { MobilePlayerBar } from './components/MobilePlayerBar'
import { isMobileShell } from './lib/platform'
import { Sidebar } from './components/Sidebar'
import { PlayerBar } from './components/PlayerBar'
import { RightPanel } from './components/RightPanel'
import { MiniPlayer } from './mini/MiniPlayer'
import { Bubble } from './bubble/Bubble'

import { Home } from './pages/Home'
import { Songs } from './pages/Songs'
import { SongDetail } from './pages/SongDetail'
import { Albums } from './pages/Albums'
import { AlbumDetail } from './pages/AlbumDetail'
import { Artists } from './pages/Artists'
import { ArtistDetail } from './pages/ArtistDetail'
import { Genres } from './pages/Genres'
import { GenreDetail } from './pages/GenreDetail'
import { Composers } from './pages/Composers'
import { ComposerDetail } from './pages/ComposerDetail'
import { Playlists } from './pages/Playlists'
import { PlaylistDetail } from './pages/PlaylistDetail'
import { Favorites } from './pages/Favorites'
import { Search } from './pages/Search'
import { Lyrics } from './pages/Lyrics'
import { Queue } from './pages/Queue'
import { History } from './pages/History'
import { Downloads } from './pages/Downloads'
import { Archive } from './pages/Archive'
import { Settings } from './pages/Settings'
import { NotFound } from './pages/NotFound'

// Module-level so rapid tab switches don't each reset the throttle.
let lastPersistRoute = 0

export default function App(): React.JSX.Element {
  return (
    <Tooltip.Provider delayDuration={350}>
      <ThemeSync />
      <Routes>
        <Route path="/mini" element={<MiniPlayer />} />
        <Route path="/bubble" element={<Bubble />} />
        <Route path="/*" element={<MainShell />} />
      </Routes>
    </Tooltip.Provider>
  )
}

function relativeLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return 0.5
  const n = parseInt(m[1], 16)
  const toLin = (c: number): number => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  return (
    0.2126 * toLin(((n >> 16) & 255) / 255) +
    0.7152 * toLin(((n >> 8) & 255) / 255) +
    0.0722 * toLin((n & 255) / 255)
  )
}

function ThemeSync(): React.JSX.Element {
  const settings = useSettings((s) => s.settings)

  useEffect(() => {
    void useSettings.getState().load()
    const unsubscribe = useSettings.getState().subscribe()
    return unsubscribe
  }, [])

  useEffect(() => {
    document.documentElement.dataset.reduceMotion = settings?.reduceMotion ? 'true' : 'false'
  }, [settings?.reduceMotion])

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = settings?.themeMode ?? 'dark'
    const accent = settings?.accentColor
    // Guard against accents that are too dark or too light to carry white
    // text (e.g. a black accent becomes invisible on OLED).
    if (accent) {
      const lum = relativeLuminance(accent)
      if (lum >= 0.08 && lum <= 0.85) {
        root.style.setProperty('--color-accent', accent)
      } else {
        root.style.removeProperty('--color-accent')
      }
    } else {
      root.style.removeProperty('--color-accent')
    }
  }, [settings?.themeMode, settings?.accentColor])

  return <></>
}

function MainShell(): React.JSX.Element {
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  // One-time bootstrap: load settings, hydrate player, restore last page.
  useEffect(() => {
    // hydrate() attaches the audio event listeners; resumePlayback() must
    // run only after that, or the resumed song plays with no listeners
    // (status stuck at 'loading', watchdog then restarts or skips it).
    void (async () => {
      await usePlayer.getState().hydrate()
      await resumePlayback()
    })()

    // A single hardware media-key press can reach us twice (global shortcut
    // plus the OS media overlay / keyboard driver): a doubled 'playPause'
    // pauses and instantly resumes, a doubled 'next' skips two songs.
    // Identical transport commands this close together are one press.
    let lastTransport = { command: '', at: 0 }
    const unsubCommands = window.cytto.on(IPC.onPlaybackCommand, (raw) => {
      const command = String(raw)
      if (command === 'playPause' || command === 'next' || command === 'previous') {
        const now = Date.now()
        if (lastTransport.command === command && now - lastTransport.at < 250) return
        lastTransport = { command, at: now }
      }
      const p = usePlayer.getState()
      if (command === 'playPause') p.toggle()
      else if (command === 'pause') p.pause()
      else if (command === 'resume') p.play()
      else if (command === 'next') p.next()
      else if (command === 'previous') p.previous()
      else if (command === 'toggleMute') p.toggleMute()
      else if (command === 'toggleShuffle') p.toggleShuffle()
      else if (command.startsWith('setVolume:')) {
        p.setVolume(Number(command.slice('setVolume:'.length)))
      } else if (command.startsWith('seek:')) {
        p.seek(Number(command.slice('seek:'.length)))
      }
    })

    // Library mutations (metadata fixes, tag edits, rescans) can re-embed
    // cover art; bump the revision so cached artwork URLs refetch.
    // Scans, metadata fixes/edits and merges change what every library page
    // shows. Only the Songs page used to refetch; Home, Albums, Artists,
    // Genres, detail pages etc. kept stale data.
    const LIBRARY_KEYS = new Set([
      'songs', 'song', 'albums', 'album', 'album-songs', 'artists', 'artist', 'artist-songs',
      'artist-albums', 'genres', 'genre-songs', 'composers', 'composer-songs', 'stats',
      'favorite-songs', 'playlists', 'playlist', 'playlist-entries', 'meta-attention'
    ])
    const unsubLibrary = window.cytto.on(IPC.onLibraryChanged, () => {
      bumpArtworkRevision()
      void queryClient.invalidateQueries({
        predicate: (q) => LIBRARY_KEYS.has(String(q.queryKey[0]))
      })
    })

    void useSettings.getState().load().then(() => {
      const prevPath = useSettings.getState().settings?.lastPage
      if (!prevPath) return
      if (
        prevPath === '/queue' ||
        prevPath === '/history' ||
        prevPath === '/lyrics' ||
        prevPath === '/nowplaying'
      ) {
        usePanels.getState().open(prevPath.slice(1) as PanelKind)
      } else if (prevPath.startsWith('/') && !prevPath.startsWith('/mini')) {
        navigate(prevPath)
      }
    })

    return () => {
      unsubCommands()
      unsubLibrary()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Persist the active route to main (throttled) whenever it changes.
  useEffect(() => {
    const persist = (): void => {
      const now = Date.now()
      if (now - lastPersistRoute < 30_000) return
      lastPersistRoute = now
      void window.cytto.invoke(IPC.setSettings, { lastPage: location.pathname })
    }
    const interval = setInterval(persist, 30_000)
    return () => clearInterval(interval)
  }, [location.pathname])

  // Custom title-bar drag region
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.altKey && e.key.toLowerCase() === 'f4') {
        void windowControl('close')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Speed / pitch / ReplayGain from Preferences, applied live (the player
  // lives in this window only, so this is not in ThemeSync).
  const audioSettings = useSettings((s) => s.settings)
  useEffect(() => {
    if (audioSettings) applyAudioSettings(audioSettings)
  }, [audioSettings?.playbackSpeed, audioSettings?.preservePitch, audioSettings?.replayGainMode]) // eslint-disable-line react-hooks/exhaustive-deps

  useGlobalShortcuts(() => setShortcutsOpen(true))
  const mobile = isMobileShell()

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-0 text-ink-0">
      {!mobile && <TitleBar />}
      <YtEngineBanner />
      <div className="relative flex min-h-0 flex-1">
        {!mobile && <Sidebar />}
        <main className="min-w-0 flex-1 overflow-y-auto">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/songs" element={<Songs />} />
            <Route path="/song/:id" element={<SongDetail />} />
            <Route path="/albums" element={<Albums />} />
            <Route path="/albums/:id" element={<AlbumDetail />} />
            <Route path="/artists" element={<Artists />} />
            <Route path="/artists/:id" element={<ArtistDetail />} />
            <Route path="/genres" element={<Genres />} />
            <Route path="/genres/:name" element={<GenreDetail />} />
            <Route path="/composers" element={<Composers />} />
            <Route path="/composers/:name" element={<ComposerDetail />} />
            <Route path="/playlists" element={<Playlists />} />
            <Route path="/playlists/:id" element={<PlaylistDetail />} />
            <Route path="/favorites" element={<Favorites />} />
            <Route path="/search" element={<Search />} />
            <Route path="/lyrics" element={<Lyrics />} />
            <Route path="/queue" element={<Queue />} />
            <Route path="/history" element={<History />} />
            <Route path="/downloads" element={<Downloads />} />
            <Route path="/archive" element={<Archive />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>
        <RightPanel />
      </div>
      {mobile ? <MobilePlayerBar /> : <PlayerBar />}
      {mobile && <MobileNav />}
      {shortcutsOpen && <ShortcutsPanel onClose={() => setShortcutsOpen(false)} />}
    </div>
  )
}
