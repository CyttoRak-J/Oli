import { Pause, Play, SkipBack, SkipForward } from 'lucide-react'
import { Artwork } from './Artwork'
import { usePlayer } from '../store/player'
import { usePanels } from '../store/panels'

/** Compact player for the phone layout: cover, title, previous / play / next, and a thin progress line. */
export function MobilePlayerBar(): React.JSX.Element {
  const current = usePlayer((s) => s.current)
  const status = usePlayer((s) => s.status)
  const currentTime = usePlayer((s) => s.currentTime)
  const duration = usePlayer((s) => s.duration)
  const toggle = usePlayer((s) => s.toggle)
  const next = usePlayer((s) => s.next)
  const previous = usePlayer((s) => s.previous)
  const togglePanel = usePanels((s) => s.toggle)
  const busy = status === 'playing' || status === 'loading'
  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0

  return (
    <div className="relative shrink-0 border-t border-edge bg-surface-1">
      <div className="absolute inset-x-0 top-0 h-0.5 bg-surface-3">
        <div className="h-full bg-accent" style={{ width: `${progress}%` }} />
      </div>
      <div className="flex h-14 items-center gap-3 px-3">
        <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => togglePanel('nowplaying')} aria-label="Now playing">
          <Artwork
            hasEmbedded={Boolean(current?.hasEmbeddedArtwork)}
            songId={current?.id}
            artworkUrl={current?.artworkUrl}
            size={40}
          />
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-semibold text-ink-0">{current?.title ?? 'Nothing playing'}</span>
            <span className="block truncate text-[11.5px] text-ink-2">{current?.artist ?? 'Pick a track to begin'}</span>
          </span>
        </button>
        <button className="p-2 text-ink-2" onClick={previous} aria-label="Previous">
          <SkipBack size={18} className="fill-current" />
        </button>
        <button
          className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-white"
          onClick={toggle}
          aria-label={busy ? 'Pause' : 'Play'}
        >
          {busy ? <Pause size={17} className="fill-current" /> : <Play size={17} className="ml-0.5 fill-current" />}
        </button>
        <button className="p-2 text-ink-2" onClick={() => next()} aria-label="Next">
          <SkipForward size={18} className="fill-current" />
        </button>
      </div>
    </div>
  )
}
