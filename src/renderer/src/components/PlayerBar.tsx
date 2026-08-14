import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  SkipBack,
  SkipForward,
  Play,
  Pause,
  Shuffle,
  Repeat,
  Repeat1,
  Volume2,
  VolumeX,
  Heart,
  Mic2,
  ListMusic,
  History
} from 'lucide-react'
import { cn } from './cn'
import { Tip } from './Tip'
import { Artwork } from './Artwork'
import { usePlayer } from '../store/player'
import { useShallow } from 'zustand/react/shallow'
import { usePanels } from '../store/panels'
import { toggleFavorite } from '../lib/ipc'
import { invalidateFavorites } from '../lib/favorites'
import { formatDuration } from '../lib/format'

const rangeFill = (pct: number): React.CSSProperties => ({
  background: `linear-gradient(to right, var(--color-accent) ${pct}%, var(--color-surface-4) ${pct}%)`
})

export function PlayerBar(): React.JSX.Element {
  const player = usePlayer(
    useShallow((s) => ({
      current: s.current,
      currentTime: s.currentTime,
      duration: s.duration,
      volume: s.volume,
      muted: s.muted,
      shuffle: s.shuffle,
      repeat: s.repeat,
      status: s.status,
      cycleRepeat: s.cycleRepeat,
      next: s.next,
      patchTrack: s.patchTrack,
      previous: s.previous,
      seek: s.seek,
      setVolume: s.setVolume,
      toggle: s.toggle,
      toggleMute: s.toggleMute,
      toggleShuffle: s.toggleShuffle
    }))
  )
  const navigate = useNavigate()
  const togglePanel = usePanels((s) => s.toggle)
  const queryClient = useQueryClient()
  const [previewTime, setPreviewTime] = useState<number | null>(null)

  const sliderValue = previewTime ?? player.currentTime
  const progressMax = Math.max(1, player.duration)
  const progressPct = Math.min(100, (sliderValue / progressMax) * 100)
  const volumePct = (player.muted ? 0 : player.volume) * 100

  const onProgressInput = (raw: string): void => {
    setPreviewTime(Number(raw))
  }
  const onProgressCommit = (): void => {
    if (previewTime != null) {
      player.seek(previewTime)
      setPreviewTime(null)
    }
  }

  const onVolumeWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
    const delta = e.deltaY > 0 ? -0.05 : 0.05
    player.setVolume(Math.min(1, Math.max(0, (player.muted ? 0 : player.volume) + delta)))
  }

  const onToggleFavorite = (): void => {
    if (!player.current) return
    void toggleFavorite('song', player.current.id).then((fav) => {
      player.patchTrack(player.current!.id, { favorite: fav })
      invalidateFavorites(queryClient)
    })
  }

  const repeatLabel =
    player.repeat === 'off' ? 'Repeat: off' : player.repeat === 'one' ? 'Repeat: one' : 'Repeat: all'

  return (
    <div className="flex h-[72px] shrink-0 items-center gap-4 border-t border-edge bg-surface-1 px-4">
      {/* Left: now playing */}
      <div className="flex min-w-0 basis-1/4 items-center gap-3">
        <Tip label="Now playing">
          <button className="shrink-0" onClick={() => togglePanel('nowplaying')} aria-label="Now playing">
            <Artwork
              hasEmbedded={Boolean(player.current?.hasEmbeddedArtwork)}
              songId={player.current?.id}
              artworkUrl={player.current?.artworkUrl}
              size={44}
            />
          </button>
        </Tip>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-ink-0">
            {player.current?.title ?? 'Nothing playing'}
          </div>
          <button
            type="button"
            className="truncate text-[12px] text-ink-2 hover:text-ink-0"
            onClick={() => {
              if (player.current?.artistId) navigate(`/artists/${player.current.artistId}`)
            }}
          >
            {player.current?.artist ?? 'Pick a track to begin'}
          </button>
        </div>
        {player.current && (
          <Tip label={player.current.favorite ? 'Remove from favorites' : 'Add to favorites'}>
            <button
              className="shrink-0 text-ink-2 transition-colors hover:text-ink-0"
              onClick={onToggleFavorite}
              aria-label="Toggle favorite"
            >
              <Heart
                size={16}
                className={cn(player.current.favorite && 'fill-accent text-accent')}
              />
            </button>
          </Tip>
        )}
      </div>

      {/* Center: transport */}
      <div className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
        <div className="flex items-center gap-4">
          <Tip label={player.shuffle ? 'Shuffle: on' : 'Shuffle: off'}>
            <button
              className={cn(
                'rounded-md transition-colors',
                player.shuffle
                  ? 'bg-accent/15 text-accent'
                  : 'text-ink-2 hover:bg-surface-2 hover:text-ink-0'
              )}
              onClick={player.toggleShuffle}
              aria-label="Shuffle"
            >
              <Shuffle size={16} />
            </button>
          </Tip>
          <Tip label="Previous">
            <button className="text-ink-2 transition-colors hover:text-ink-0" onClick={player.previous} aria-label="Previous">
              <SkipBack size={20} />
            </button>
          </Tip>
          <Tip label={player.status === 'playing' ? 'Pause' : 'Play'}>
            <button
              className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-white transition-transform hover:scale-105"
              onClick={player.toggle}
              aria-label={player.status === 'playing' ? 'Pause' : 'Play'}
            >
              {player.status === 'playing' ? (
                <Pause size={20} className="fill-current" />
              ) : (
                <Play size={20} className="ml-0.5 fill-current" />
              )}
            </button>
          </Tip>
          <Tip label="Next">
            <button className="text-ink-2 transition-colors hover:text-ink-0" onClick={() => player.next()} aria-label="Next">
              <SkipForward size={20} />
            </button>
          </Tip>
          <Tip label={repeatLabel}>
            <button
              className={cn(
                'rounded-md transition-colors',
                player.repeat !== 'off'
                  ? 'bg-accent/15 text-accent'
                  : 'text-ink-2 hover:bg-surface-2 hover:text-ink-0'
              )}
              onClick={player.cycleRepeat}
              aria-label="Repeat"
            >
              {player.repeat === 'one' ? <Repeat1 size={16} /> : <Repeat size={16} />}
            </button>
          </Tip>
        </div>
        <div className="flex w-full max-w-xl items-center gap-2">
          <span className="w-10 text-right text-[10.5px] tabular-nums text-ink-2">
            {formatDuration(sliderValue)}
          </span>
          <input
            type="range"
            className="flex-1"
            min={0}
            max={progressMax}
            step={0.1}
            value={Math.min(sliderValue ?? 0, progressMax)}
            style={rangeFill(progressPct)}
            onInput={(e) => onProgressInput((e.target as HTMLInputElement).value)}
            onPointerUp={onProgressCommit}
            onKeyUp={(e) => {
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') onProgressCommit()
            }}
            aria-label="Seek"
          />
          <span className="w-10 text-[10.5px] tabular-nums text-ink-2">
            {formatDuration(player.duration)}
          </span>
        </div>
      </div>

      {/* Right: queue + history + lyrics + volume */}
      <div className="flex min-w-0 basis-1/4 items-center justify-end gap-3">
        <Tip label="Queue">
          <button className="text-ink-2 transition-colors hover:text-ink-0" onClick={() => togglePanel('queue')} aria-label="Queue">
            <ListMusic size={18} />
          </button>
        </Tip>
        <Tip label="History">
          <button className="text-ink-2 transition-colors hover:text-ink-0" onClick={() => togglePanel('history')} aria-label="History">
            <History size={18} />
          </button>
        </Tip>
        <Tip label="Lyrics">
          <button className="text-ink-2 transition-colors hover:text-ink-0" onClick={() => togglePanel('lyrics')} aria-label="Lyrics">
            <Mic2 size={18} />
          </button>
        </Tip>
        <div className="flex items-center gap-1.5" onWheel={onVolumeWheel}>
          <Tip label={player.muted ? 'Unmute' : 'Mute'}>
            <button
              className="text-ink-2 transition-colors hover:text-ink-0"
              onClick={player.toggleMute}
              aria-label="Mute"
            >
              {player.muted || player.volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>
          </Tip>
          <input
            type="range"
            className="w-24"
            min={0}
            max={1}
            step={0.01}
            value={player.muted ? 0 : player.volume}
            style={rangeFill(volumePct)}
            onInput={(e) => player.setVolume(Number((e.target as HTMLInputElement).value))}
            aria-label="Volume"
          />
        </div>
      </div>
    </div>
  )
}
