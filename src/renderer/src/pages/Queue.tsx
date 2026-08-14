import { Play, Pause, X, ListMusic, Trash2 } from 'lucide-react'
import { usePlayer } from '../store/player'
import { useShallow } from 'zustand/react/shallow'
import { Artwork } from '../components/Artwork'
import { EmptyState } from '../components/EmptyState'
import { formatDuration } from '../lib/format'
import { cn } from '../components/cn'
import { ListJumpButtons } from '../components/ListJumpButtons'
import type { Track } from '@shared/types'

export function Queue(): React.JSX.Element {
  const player = usePlayer(
    useShallow((s) => ({
      queue: s.queue,
      index: s.index,
      status: s.status,
      clearQueue: s.clearQueue,
      pause: s.pause,
      play: s.play,
      playTrack: s.playTrack,
      removeFromQueue: s.removeFromQueue
    }))
  )
  const { queue, index, status } = player

  const playAt = (track: Track): void => {
    player.playTrack(track, { source: 'queue', sourceId: null })
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="sticky top-0 z-20 mb-4 flex items-center justify-between gap-3 bg-surface-1/85 px-2 py-2 backdrop-blur-sm">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-ink-0">
          <ListMusic size={22} /> Queue
          <span className="text-[12px] font-normal text-ink-3">
            {queue.length > 0 ? `${queue.length} tracks` : ''}
          </span>
        </h1>
        <div className="flex items-center gap-2">
          <ListJumpButtons ids={queue.map((t) => t.id)} />
          {queue.length > 0 && (
            <button
              className="flex items-center gap-1.5 rounded-lg border border-surface-4 bg-surface-2 px-3 py-1.5 text-[12px] text-ink-2 hover:border-red-400/60 hover:text-red-300"
              onClick={() => player.clearQueue()}
            >
              <Trash2 size={13} /> Clear queue
            </button>
          )}
        </div>
      </div>

      {queue.length === 0 ? (
        <EmptyState
          icon={<ListMusic size={36} className="mx-auto" />}
          title="Queue is empty"
          description="Play a song from your library to build a queue."
        />
      ) : (
        <div className="flex flex-col">
          {queue.map((track, i) => {
            const isCurrent = i === index && status !== 'idle'
            const isPlaying = isCurrent && status === 'playing'
            return (
              <div
                key={track.id}
                data-track-id={track.id}
                className={cn(
                  'group flex items-center gap-3 rounded-lg px-2 py-2',
                  isCurrent ? 'bg-surface-2' : 'hover:bg-surface-1'
                )}
                onDoubleClick={() => playAt(track)}
              >
                <button
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-surface-4 bg-surface-2 text-ink-2 transition-colors group-hover:border-accent group-hover:text-ink-0"
                  onClick={() => {
                    if (isPlaying) player.pause()
                    else if (isCurrent) player.play()
                    else playAt(track)
                  }}
                  aria-label={isPlaying ? 'Pause' : 'Play'}
                >
                  {isPlaying ? (
                    <Pause size={14} className="fill-current" />
                  ) : (
                    <Play size={14} className="ml-0.5 fill-current" />
                  )}
                </button>
                <Artwork
                  songId={track.id}
                  hasEmbedded={track.hasEmbeddedArtwork}
                  artworkUrl={track.artworkUrl}
                  label={track.title}
                  size={36}
                />
                <div className="min-w-0 flex-1">
                  <button
                    className={cn(
                      'block w-full min-w-0 truncate text-left text-[13px] font-medium leading-snug',
                      isCurrent ? 'text-accent' : 'text-ink-0 hover:text-accent'
                    )}
                    onClick={() => playAt(track)}
                    title="Play song"
                  >
                    {track.title}
                  </button>
                  <div className="truncate text-[11.5px] text-ink-2">
                    {track.artist}
                    {track.album ? ` · ${track.album}` : ''}
                  </div>
                </div>
                <span className="text-[11.5px] tabular-nums text-ink-3">
                  {formatDuration(track.duration)}
                </span>
                <button
                  className="p-1 text-ink-3 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
                  onClick={() => player.removeFromQueue(track.id)}
                  aria-label="Remove from queue"
                >
                  <X size={14} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}