import { useRef } from 'react'
import { X } from 'lucide-react'
import { usePanels } from '../store/panels'
import { Queue } from '../pages/Queue'
import { History } from '../pages/History'
import { Lyrics } from '../pages/Lyrics'
import { NowPlaying } from '../pages/NowPlaying'
import { isMobileShell } from '../lib/platform'
import { cn } from './cn'

const TITLES: Record<string, string> = {
  nowplaying: 'Now Playing',
  queue: 'Queue',
  history: 'History',
  lyrics: 'Lyrics'
}

/** How far (px) a downward swipe must go to close a panel on a phone. */
const SWIPE_CLOSE_PX = 110

/** Right-hand overlay panel for Queue / History / Lyrics. */
export function RightPanel(): React.JSX.Element | null {
  const panel = usePanels((s) => s.panel)
  const close = usePanels((s) => s.close)
  const phone = isMobileShell()
  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const swipe = useRef<{ x: number; y: number; atTop: boolean; dragging: boolean; dy: number } | null>(null)

  if (!panel) return null

  // Phone: swipe down anywhere on the panel (its list scrolled to the top) and it slides away, back to the page underneath.
  const onTouchStart = (e: React.TouchEvent): void => {
    if (!phone || e.touches.length !== 1) return
    const target = e.target as HTMLElement
    // the seek bar and other sliders keep their own drag
    if (target.closest('input[type="range"]')) {
      swipe.current = null
      return
    }
    const t = e.touches[0]
    swipe.current = { x: t.clientX, y: t.clientY, atTop: (bodyRef.current?.scrollTop ?? 0) <= 0, dragging: false, dy: 0 }
  }
  const onTouchMove = (e: React.TouchEvent): void => {
    const s = swipe.current
    const root = rootRef.current
    if (!s || !root || e.touches.length !== 1) return
    const t = e.touches[0]
    const dy = t.clientY - s.y
    const dx = t.clientX - s.x
    if (!s.dragging) {
      // start only for a mostly vertical pull down from the top of the list
      if (!s.atTop || dy < 10 || Math.abs(dx) > dy) return
      s.dragging = true
    }
    s.dy = Math.max(0, dy)
    root.style.transition = 'none'
    root.style.transform = `translateY(${s.dy}px)`
  }
  const onTouchEnd = (): void => {
    const s = swipe.current
    const root = rootRef.current
    swipe.current = null
    if (!s || !root || !s.dragging) return
    root.style.transition = 'transform 160ms ease-out'
    if (s.dy >= SWIPE_CLOSE_PX) {
      root.style.transform = 'translateY(100%)'
      setTimeout(close, 150)
    } else {
      root.style.transform = ''
    }
  }

  return (
    <div
      ref={rootRef}
      className={cn(
        'flex flex-col bg-surface-1',
        // phone: the panel covers the page (above the player bar and the tabs); desktop: a 400 px column on the right
        phone ? 'absolute inset-0 z-30' : 'w-[400px] max-w-[92vw] shrink-0 border-l border-edge'
      )}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
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
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
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
