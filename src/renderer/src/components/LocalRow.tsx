import { useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Play } from 'lucide-react'
import type { Track } from '@shared/types'
import { Artwork } from './Artwork'
import { formatDuration } from '../lib/format'

export function LocalRow({ track, onPlay }: { track: Track; onPlay: () => void }): React.JSX.Element {
  const navigate = useNavigate()
  const navTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  return (
    <div
      className="group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-surface-1"
      onDoubleClick={() => {
        if (navTimerRef.current) {
          clearTimeout(navTimerRef.current)
          navTimerRef.current = null
        }
        onPlay()
      }}
    >
      <Artwork songId={track.id} hasEmbedded={track.hasEmbeddedArtwork} size={36} />
      <div className="min-w-0 flex-1">
        <button
          className="block w-full min-w-0 break-words text-left text-[13px] font-medium leading-snug text-ink-0 hover:text-accent"
          onClick={() => {
            if (navTimerRef.current) clearTimeout(navTimerRef.current)
            navTimerRef.current = setTimeout(() => navigate(`/song/${track.id}`), 250)
          }}
          title="View song info"
        >
          {track.title}
        </button>
        <div className="truncate text-[11.5px] text-ink-2">
          {track.artist}
          {track.album ? ` · ${track.album}` : ''}
        </div>
      </div>
      <span className="text-[11.5px] tabular-nums text-ink-3">{formatDuration(track.duration)}</span>
      <button
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-surface-4 bg-surface-2 text-ink-2 opacity-0 transition-all group-hover:border-accent group-hover:opacity-100"
        onClick={onPlay}
        aria-label="Play"
      >
        <Play size={14} className="ml-0.5 fill-current" />
      </button>
    </div>
  )
}
