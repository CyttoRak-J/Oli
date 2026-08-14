import { X } from 'lucide-react'
import { usePanels } from '../store/panels'
import { Queue } from '../pages/Queue'
import { History } from '../pages/History'
import { Lyrics } from '../pages/Lyrics'
import { NowPlaying } from '../pages/NowPlaying'

const TITLES: Record<string, string> = {
  nowplaying: 'Now Playing',
  queue: 'Queue',
  history: 'History',
  lyrics: 'Lyrics'
}

/** Right-hand overlay panel for Queue / History / Lyrics. */
export function RightPanel(): React.JSX.Element | null {
  const panel = usePanels((s) => s.panel)
  const close = usePanels((s) => s.close)

  if (!panel) return null

  return (
    <div className="flex w-[400px] max-w-[92vw] shrink-0 flex-col border-l border-edge bg-surface-1">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-edge px-4">
        <span className="text-[13px] font-bold text-ink-0">{TITLES[panel]}</span>
        <button
          className="rounded-md p-1.5 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink-0"
          onClick={close}
          aria-label="Close panel"
        >
          <X size={15} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {panel === 'nowplaying' ? (
          <NowPlaying />
        ) : panel === 'queue' ? (
          <Queue />
        ) : panel === 'history' ? (
          <History />
        ) : (
          <Lyrics />
        )}
      </div>
    </div>
  )
}
