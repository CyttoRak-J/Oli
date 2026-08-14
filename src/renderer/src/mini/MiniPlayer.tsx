import { useEffect, useState } from 'react'
import { IPC } from '@shared/ipc'
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  X,
  Maximize2,
  Volume2,
  VolumeX,
  CircleDot,
  SlidersHorizontal
} from 'lucide-react'
import { Artwork } from '../components/Artwork'
import { commandPlayback, getPlaybackState, getSongById, windowControl, on } from '../lib/ipc'
import { formatDuration } from '../lib/format'
import { useSettings } from '../store/settings'
import type { PlaybackState, Track } from '@shared/types'

const NO_DRAG = 'app-region-no-drag'

export function MiniPlayer(): React.JSX.Element {
  const [state, setState] = useState<PlaybackState | null>(null)
  const [localVol, setLocalVol] = useState<number | null>(null)
  const [localSeek, setLocalSeek] = useState<number | null>(null)
  const [showBubbleOpts, setShowBubbleOpts] = useState(false)
  const bubbleOpacity = useSettings((s) => s.settings?.miniPlayerOpacity ?? 1)

  const applyState = (s: PlaybackState): void => {
    setState(s)
    setLocalVol((lv) => (lv != null && Math.abs(s.volume - lv) < 0.02 ? null : lv))
  }

  useEffect(() => {
    let disposed = false
    void getPlaybackState().then((s) => {
      if (!disposed) applyState(s)
    })
    const unsub = on<PlaybackState>(IPC.onPlaybackState, (s) => applyState(s))
    const interval = setInterval(() => {
      if (disposed) return
      void getPlaybackState().then((s) => applyState(s))
    }, 15000)
    return () => {
      disposed = true
      unsub()
      clearInterval(interval)
    }
  }, [])

  const songId = state?.songId ?? null
  const [trackCache, setTrackCache] = useState<Record<string, Track | null>>({})

  useEffect(() => {
    if (!songId) return
    let disposed = false
    if (!(songId in trackCache)) {
      void getSongById(songId).then((t) => {
        if (!disposed) setTrackCache((m) => ({ ...m, [songId]: t }))
      })
    }
    return () => {
      disposed = true
    }
  }, [songId, trackCache])

  const track = songId == null ? null : (trackCache[songId] ?? null)
  const displayTitle = track?.title ?? state?.title ?? 'Nothing playing'
  const displayArtist = track?.artist ?? state?.artist ?? '—'
  const displayTrack = track ?? {
    id: songId ?? '',
    artworkUrl: state?.artworkUrl ?? null,
    title: state?.title ?? '',
    artist: state?.artist ?? ''
  }

  const status = state?.status ?? 'idle'
  const currentTime = state?.currentTime ?? 0
  const duration = state?.duration ?? 0
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0
  const muted = state?.volume === 0 || (state?.muted ?? false)
  const volume = localVol ?? state?.volume ?? 0.8

  const cmd = (c: 'playPause' | 'next' | 'previous' | 'toggleMute'): void => {
    commandPlayback(c)
  }

  const changeVolume = (delta: number): void => {
    const v = Math.min(1, Math.max(0, (muted ? 0 : volume) + delta))
    setLocalVol(v)
    commandPlayback(`setVolume:${v}`)
  }

  const onWheel = (e: React.WheelEvent): void => {
    changeVolume(e.deltaY > 0 ? -0.05 : 0.05)
  }

  return (
    <div className="app-region-drag flex h-full flex-col overflow-hidden bg-surface-0 text-ink-0">
      <div className="flex h-8 shrink-0 items-center justify-between px-1.5">
        <button
          className={`rounded-md p-1.5 text-ink-3 hover:bg-surface-1 hover:text-ink-0 ${NO_DRAG}`}
          onClick={() => void windowControl('expand-mini')}
          title="Back to main player"
          aria-label="Back to main player"
        >
          <Maximize2 size={13} />
        </button>
        <button
          className={`rounded-md p-1.5 text-ink-3 hover:bg-surface-1 hover:text-ink-0 ${NO_DRAG}`}
          onClick={() => setShowBubbleOpts((v) => !v)}
          title="Bubble appearance"
          aria-label="Bubble appearance"
        >
          <SlidersHorizontal size={13} />
        </button>
        <button
          className={`rounded-md p-1.5 text-ink-3 hover:bg-surface-1 hover:text-ink-0 ${NO_DRAG}`}
          onClick={() => void windowControl('to-bubble')}
          title="Minimize to bubble"
          aria-label="Minimize to bubble"
        >
          <CircleDot size={13} />
        </button>
        <button
          className={`rounded-md p-1.5 text-ink-3 hover:bg-surface-1 hover:text-ink-0 ${NO_DRAG}`}
          onClick={() => void windowControl('close')}
          title="Close mini player"
          aria-label="Close mini player"
        >
          <X size={13} />
        </button>
      </div>

      {showBubbleOpts && (
        <div className={`mx-2 mb-1 flex shrink-0 items-center gap-2 rounded-lg bg-surface-1 px-2.5 py-2 ${NO_DRAG}`}>
          <span className="text-[11px] whitespace-nowrap text-ink-2">Bubble opacity</span>
          <input
            type="range"
            className="min-w-0 flex-1"
            min={0.25}
            max={1}
            step={0.05}
            value={bubbleOpacity}
            style={{
              background: `linear-gradient(to right, var(--color-accent) ${
                ((bubbleOpacity - 0.25) / 0.75) * 100
              }%, var(--color-surface-4) ${((bubbleOpacity - 0.25) / 0.75) * 100}%)`
            }}
            onInput={(e) => {
              void useSettings.getState().set({ miniPlayerOpacity: Number((e.target as HTMLInputElement).value) })
            }}
            aria-label="Bubble opacity"
          />
          <span className="w-9 text-right text-[11px] tabular-nums text-ink-2">{Math.round(bubbleOpacity * 100)}%</span>
        </div>
      )}

      <div className="flex min-h-0 w-full flex-1 items-center justify-center px-4">
        <Artwork
          songId={displayTrack.id}
          hasEmbedded={track?.hasEmbeddedArtwork}
          artworkUrl={displayTrack.artworkUrl ?? undefined}
          label={track ? `${track.title} ${track.artist}` : `${displayTitle} ${displayArtist}`}
          fluid
          rounded="rounded-2xl"
          className="drop-shadow-2xl"
          style={{ aspectRatio: '1 / 1', width: 'auto', height: 'auto', maxWidth: '100%', maxHeight: '100%' }}
        />
      </div>

      <div className="w-full px-4 text-center">
        <div className="truncate text-[13px] font-semibold text-ink-0">{displayTitle}</div>
        <div className="truncate text-[11.5px] text-ink-2">{displayArtist}</div>
      </div>

      <div className={`w-full px-4 ${NO_DRAG}`}>
        <input
          type="range"
          className="progress-slider w-full"
          min={0}
          max={Math.max(duration, 0.01)}
          step={0.1}
          value={localSeek ?? currentTime}
          disabled={duration <= 0}
          style={{
            background: `linear-gradient(to right, var(--color-accent) ${pct}%, var(--color-surface-4) ${pct}%)`
          }}
          onInput={(e) => {
            const v = Number((e.target as HTMLInputElement).value)
            setLocalSeek(v)
            commandPlayback(`seek:${v}`)
          }}
          onPointerUp={() => setLocalSeek(null)}
          onBlur={() => setLocalSeek(null)}
          aria-label="Seek"
        />
        <div className="mt-0.5 flex justify-between text-[10px] tabular-nums text-ink-3">
          <span>{formatDuration(localSeek ?? currentTime)}</span>
          <span>{duration > 0 ? formatDuration(duration) : '—'}</span>
        </div>
      </div>

      <div className="flex w-full flex-wrap items-center justify-center gap-x-4 gap-y-2 px-4 pb-3 pt-1">
        <button
          className={`text-ink-2 transition-colors hover:text-ink-0 ${NO_DRAG}`}
          onClick={() => cmd('previous')}
          title="Previous"
          aria-label="Previous"
        >
          <SkipBack size={20} className="fill-current" />
        </button>
        <button
          className={`flex h-11 w-11 items-center justify-center rounded-full bg-accent text-white shadow-lg transition-transform hover:scale-105 ${NO_DRAG}`}
          onClick={() => cmd('playPause')}
          title={status === 'playing' ? 'Pause' : 'Play'}
          aria-label="Play or pause"
        >
          {status === 'playing' ? (
            <Pause size={18} className="fill-current" />
          ) : (
            <Play size={18} className="ml-0.5 fill-current" />
          )}
        </button>
        <button
          className={`text-ink-2 transition-colors hover:text-ink-0 ${NO_DRAG}`}
          onClick={() => cmd('next')}
          title="Next"
          aria-label="Next"
        >
          <SkipForward size={20} className="fill-current" />
        </button>
        <div className={`flex min-w-0 items-center gap-1.5 ${NO_DRAG}`} onWheel={onWheel}>
          <button
            className="shrink-0 text-ink-2 transition-colors hover:text-ink-0"
            onClick={() => cmd('toggleMute')}
            title={muted ? 'Unmute' : 'Mute'}
            aria-label={muted ? 'Unmute' : 'Mute'}
          >
            {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </button>
          <input
            type="range"
            className="w-20 min-w-0 flex-1"
            min={0}
            max={1}
            step={0.01}
            value={muted ? 0 : volume}
            style={{
              background: `linear-gradient(to right, var(--color-accent) ${
                (muted ? 0 : volume) * 100
              }%, var(--color-surface-4) ${(muted ? 0 : volume) * 100}%)`
            }}
            onInput={(e) => {
              const v = Number((e.target as HTMLInputElement).value)
              setLocalVol(v)
              commandPlayback(`setVolume:${v}`)
            }}
            aria-label="Volume"
          />
        </div>
      </div>
    </div>
  )
}
