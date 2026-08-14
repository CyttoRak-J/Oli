import { useRef } from 'react'
import { ArrowUp, AudioLines } from 'lucide-react'
import { Tip } from './Tip'
import { usePlayer } from '../store/player'
import { useShallow } from 'zustand/react/shallow'

const BTN_CLS =
  'flex h-8 w-8 items-center justify-center rounded-lg border border-edge bg-surface-2 text-ink-2 shadow-md shadow-black/25 transition-colors hover:border-accent hover:text-ink-0 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-edge disabled:hover:text-ink-2'

interface ListJumpButtonsProps {
  /** Track ids shown in the list (used to enable the "go to current" button). */
  ids?: string[]
  /**
   * Optional explicit CSS selector for the currently playing item, for lists
   * that aren't track rows (e.g. album / artist cards). When provided it
   * replaces the default `[data-track-id=...]` lookup.
   */
  currentSelector?: string | null
}

/**
 * Two buttons for a scrollable list: scroll to the top, and jump to the
 * currently playing track (highlighting it briefly).
 */
export function ListJumpButtons({
  ids = [],
  currentSelector
}: ListJumpButtonsProps): React.JSX.Element {
  const player = usePlayer(useShallow((s) => ({ current: s.current, status: s.status })))
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const currentId = player.current?.id ?? null
  const defaultSelector =
    player.status !== 'idle' && currentId != null && ids.includes(currentId)
      ? `[data-track-id="${CSS.escape(currentId)}"]`
      : null
  const selector = currentSelector ?? defaultSelector

  const scrollParent = (): HTMLElement => {
    let node: HTMLElement | null = wrapRef.current
    while (node) {
      const style = getComputedStyle(node)
      if (node.scrollHeight > node.clientHeight && /(auto|scroll|overlay)/.test(style.overflowY)) {
        return node
      }
      node = node.parentElement
    }
    return document.documentElement
  }

  const toTop = (): void => {
    scrollParent().scrollTo({ top: 0, behavior: 'smooth' })
  }

  const toCurrent = (): void => {
    if (!selector) return
    const el = scrollParent().querySelector<HTMLElement>(selector)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.remove('list-jump-flash')
    void el.offsetWidth
    el.classList.add('list-jump-flash')
  }

  return (
    <div ref={wrapRef} className="flex items-center gap-1.5">
      <Tip label="Scroll to top">
        <button className={BTN_CLS} onClick={toTop} aria-label="Scroll to top">
          <ArrowUp size={14} />
        </button>
      </Tip>
      <Tip label={selector ? 'Go to playing track' : 'Playing track not in this list'}>
        <button
          className={BTN_CLS}
          onClick={toCurrent}
          disabled={!selector}
          aria-label="Go to playing track"
        >
          <AudioLines size={14} />
        </button>
      </Tip>
    </div>
  )
}
