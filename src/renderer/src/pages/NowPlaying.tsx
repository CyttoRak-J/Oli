import { useState } from 'react'
import { Play, Pause, SkipBack, SkipForward, Disc3, ListMusic } from 'lucide-react'
import { usePlayer } from '../store/player'
import { useShallow } from 'zustand/react/shallow'
import { Artwork } from '../components/Artwork'
import { EmptyState } from '../components/EmptyState'
import { formatDuration } from '../lib/format'
import { useTrackInfo } from '../lib/useTrackInfo'
import type { Track } from '@shared/types'

/**
 * Walkman-style Now Playing view: big cover, transport controls and a
 * progress bar, with the Up Next queue listed below.
 */
export function NowPlaying(): React.JSX.Element {
  const player = usePlayer(
    useShallow((s) => ({
      current: s.current,
      status: s.status,
      currentTime: s.currentTime,
      duration: s.duration,
      queue: s.queue,
      index: s.index,
      next: s.next,
      playTrack: s.playTrack,
      previous: s.previous,
      seek: s.seek,
      toggle: s.toggle
    }))
  )
  const openInfo = useTrackInfo()
  const [previewTime, setPreviewTime] = useState<number | null>(null)

  const { current, status, currentTime, duration, queue, index } = player

  if (!current || status === 'idle') {
    return (
      <div className="p-6">
        <EmptyState
          icon={<Disc3 size={40} className="mx-auto" />}
          title="Nothing playing"
          description="Start a track to see the Now Playing view."
        />
      </div>
    )
  }

  const sliderValue = previewTime ?? currentTime
  const progressMax = Math.max(1, duration)
  const progressPct = Math.min(100, (sliderValue / progressMax) * 100)
  const upcoming = queue.slice(index + 1)

  const onSeek = (raw: string): void => {
    setPreviewTime(Number(raw))
  }
  const onSeekCommit = (): void => {
    if (previewTime != null) {
      player.seek(previewTime)
      setPreviewTime(null)
    }
  }

  const playAt = (track: Track): void => {
    player.playTrack(track, { source: 'queue', sourceId: null })
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 p-6">
      <div className="mx-auto w-full max-w-[260px]">
        <Artwork
          songId={current.id}
          hasEmbedded={current.hasEmbeddedArtwork}
          artworkUrl={current.artworkUrl}
          label={`${current.title} ${current.artist}`}
          fluid
          rounded="rounded-2xl"
          className="drop-shadow-2xl"
        />
      </div>

      <div className="text-center">
        <button
          className="truncate text-[16px] font-bold text-ink-0 hover:text-accent"
          onClick={() => openInfo(current)}
          title="View song info"
        >
          {current.title}
        </button>
        <div className="truncate text-[13px] text-ink-2">
          {current.artist}
          {current.album ? ` · ${current.album}` : ''}
        </div>
      </div>

      <div>
        <input
          type="range"
          className="w-full"
          min={0}
          max={progressMax}
          step={0.1}
          value={Math.min(sliderValue, progressMax)}
          style={{
            background: `linear-gradient(to right, var(--color-accent) ${progressPct}%, var(--color-surface-4) ${progressPct}%)`
          }}
          onInput={(e) => onSeek((e.target as HTMLInputElement).value)}
          onPointerUp={onSeekCommit}
          aria-label="Seek"
        />
        <div className="mt-1 flex justify-between text-[10.5px] tabular-nums text-ink-3">
          <span>{formatDuration(sliderValue)}</span>
          <span>{duration > 0 ? formatDuration(duration) : '—'}</span>
        </div>
      </div>

      <div className="flex items-center justify-center gap-6">
        <button
          className="text-ink-2 transition-colors hover:text-ink-0"
          onClick={player.previous}
          aria-label="Previous"
        >
          <SkipBack size={22} className="fill-current" />
        </button>
        <button
          className="flex h-12 w-12 items-center justify-center rounded-full bg-accent text-white shadow-lg transition-transform hover:scale-105"
          onClick={player.toggle}
          aria-label={status === 'playing' ? 'Pause' : 'Play'}
        >
          {status === 'playing' ? (
            <Pause size={20} className="fill-current" />
          ) : (
            <Play size={20} className="ml-0.5 fill-current" />
          )}
        </button>
        <button
          className="text-ink-2 transition-colors hover:text-ink-0"
          onClick={() => player.next()}
          aria-label="Next"
        >
          <SkipForward size={22} className="fill-current" />
        </button>
      </div>

      <div className="flex items-center gap-2 border-t border-edge pt-4 text-[10.5px] font-bold uppercase tracking-widest text-ink-3">
        <ListMusic size={13} /> Up Next
      </div>
      {upcoming.length === 0 ? (
        <div className="py-6 text-center text-[12.5px] text-ink-3">
          End of queue — nothing up next.
        </div>
      ) : (
        <div className="flex flex-col">
          {upcoming.map((track) => (
            <div
              key={track.id}
              className="group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-surface-1"
              onDoubleClick={() => playAt(track)}
            >
              <button
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-surface-4 bg-surface-2 text-ink-2 opacity-0 transition-opacity group-hover:border-accent group-hover:opacity-100"
                onClick={() => playAt(track)}
                aria-label="Play"
              >
                <Play size={13} className="ml-0.5 fill-current" />
              </button>
              <Artwork
                  songId={track.id}
                  hasEmbedded={track.hasEmbeddedArtwork}
                  artworkUrl={track.artworkUrl}
                  label={track.title}
                  size={32}
                />
              <div className="min-w-0 flex-1">
                <button
                  className="block w-full min-w-0 truncate text-left text-[12.5px] font-medium leading-snug text-ink-0 hover:text-accent"
                  onClick={() => openInfo(track)}
                  title="View song info"
                >
                  {track.title}
                </button>
                <div className="truncate text-[11px] text-ink-2">{track.artist}</div>
              </div>
              <span className="text-[11px] tabular-nums text-ink-3">
                {formatDuration(track.duration)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
