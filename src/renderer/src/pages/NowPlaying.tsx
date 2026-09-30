import { useSeekSlider } from '../lib/useRangeCommit'
import { Info, Play, Pause, SkipBack, SkipForward, Disc3, ListMusic, Radio, Shuffle, Repeat, Repeat1, History, Mic2 } from 'lucide-react'
import { usePlayer } from '../store/player'
import { useShallow } from 'zustand/react/shallow'
import { Artwork } from '../components/Artwork'
import { EmptyState } from '../components/EmptyState'
import { formatDuration } from '../lib/format'
import { useTrackInfo } from '../lib/useTrackInfo'
import { SleepTimer } from '../components/SleepTimer'
import { usePanels } from '../store/panels'
import { isMobileShell } from '../lib/platform'
import { cn } from '../components/cn'
import { tapToPlay } from '../lib/rowTap'
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
      toggle: s.toggle,
      radioMode: s.radioMode,
      toggleRadioMode: s.toggleRadioMode,
      shuffle: s.shuffle,
      repeat: s.repeat,
      toggleShuffle: s.toggleShuffle,
      cycleRepeat: s.cycleRepeat
    }))
  )
  const togglePanel = usePanels((s) => s.toggle)
  const phone = isMobileShell()
  const openInfo = useTrackInfo()
  const { ref: sliderRef, preview: sliderPreview, props: sliderProps } = useSeekSlider((v) => player.seek(v))
  const previewTime = sliderPreview

  const { current, status, currentTime, duration, queue, index, radioMode, toggleRadioMode } = player

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
  // the player's duration can still be 0 while a stream loads: fall back to the song's own length so the bar has a range
  const progressMax = Math.max(1, duration || current.duration || 0)
  const progressPct = Math.min(100, (sliderValue / progressMax) * 100)
  const upcoming = queue.slice(index + 1)

  const playAt = (track: Track): void => {
    player.playTrack(track, { source: 'queue', sourceId: null })
  }

  return (
    <div className={cn('mx-auto flex max-w-3xl flex-col', phone ? 'gap-3 p-4' : 'gap-5 p-6')}>
      <div className={cn('mx-auto w-full', phone ? 'max-w-[min(260px,34vh)]' : 'max-w-[260px]')}>
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
          ref={sliderRef}
          type="range"
          className="w-full"
          min={0}
          max={progressMax}
          step={0.1}
          value={Math.min(sliderValue, progressMax)}
          style={{
            background: `linear-gradient(to right, var(--color-accent) ${progressPct}%, var(--color-surface-4) ${progressPct}%)`,
            touchAction: 'none'
          }}
          {...sliderProps}
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
          aria-label={status === 'playing' || status === 'loading' ? 'Pause' : 'Play'}
        >
          {status === 'playing' || status === 'loading' ? (
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

      {phone && (
        // The desktop has these in its player bar; the phone's small bar has only previous / play / next.
        <div className="flex items-center justify-around">
          <button
            className={cn('rounded-full p-2.5', player.shuffle ? 'bg-accent/15 text-accent' : 'text-ink-2')}
            onClick={player.toggleShuffle}
            aria-label="Shuffle"
            aria-pressed={player.shuffle}
          >
            <Shuffle size={19} />
          </button>
          <button
            className={cn('rounded-full p-2.5', player.repeat !== 'off' ? 'bg-accent/15 text-accent' : 'text-ink-2')}
            onClick={player.cycleRepeat}
            aria-label={player.repeat === 'off' ? 'Repeat: off' : player.repeat === 'one' ? 'Repeat: one' : 'Repeat: all'}
          >
            {player.repeat === 'one' ? <Repeat1 size={19} /> : <Repeat size={19} />}
          </button>
          <button className="rounded-full p-2.5 text-ink-2" onClick={() => togglePanel('queue')} aria-label="Queue">
            <ListMusic size={19} />
          </button>
          <button className="rounded-full p-2.5 text-ink-2" onClick={() => togglePanel('history')} aria-label="History">
            <History size={19} />
          </button>
          <button className="rounded-full p-2.5 text-ink-2" onClick={() => togglePanel('lyrics')} aria-label="Lyrics">
            <Mic2 size={19} />
          </button>
        </div>
      )}

      <div className="flex items-center justify-between border-t border-edge pt-4">
        <div className="flex items-center gap-2 text-[10.5px] font-bold uppercase tracking-widest text-ink-3">
          <ListMusic size={13} /> Up Next
        </div>
        <div className="flex items-center gap-2">
          <button
            className={
              radioMode
                ? 'flex items-center gap-1 rounded-full bg-accent px-2.5 py-1 text-[11px] font-bold text-white'
                : 'flex items-center gap-1 rounded-full border border-surface-4 bg-surface-2 px-2.5 py-1 text-[11px] text-ink-2 hover:border-accent'
            }
            onClick={toggleRadioMode}
            title="Radio mode: auto-queue similar tracks when the queue ends"
          >
            <Radio size={12} /> Radio
          </button>
          <SleepTimer />
        </div>
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
              {...tapToPlay(() => playAt(track))}
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
                  onClick={() => (phone ? playAt(track) : openInfo(track))}
                  title={phone ? 'Play' : 'View song info'}
                >
                  {track.title}
                </button>
                <div className="truncate text-[11px] text-ink-2">{track.artist}</div>
              </div>
              {phone && (
                <button
                  className="shrink-0 rounded-full p-1.5 text-ink-3"
                  onClick={(e) => {
                    e.stopPropagation()
                    openInfo(track)
                  }}
                  aria-label="Song info"
                >
                  <Info size={15} />
                </button>
              )}
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
