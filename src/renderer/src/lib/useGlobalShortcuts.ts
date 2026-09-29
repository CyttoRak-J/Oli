import { useEffect, useRef } from 'react'
import { usePlayer } from '../store/player'

/**
 * ADDED: there was no in-app keyboard shortcut handling at all beyond
 * Alt+F4 (window close) and Escape (closing a context menu) — no space to
 * play/pause, no arrow-key seek/volume, nothing. Standard, low-risk
 * shortcuts for a music player. Skips firing while focus is in a text
 * input/textarea/contenteditable so typing (e.g. in the search bar) is
 * never intercepted.
 */
export const SHORTCUTS: Array<{ keys: string; description: string }> = [
  { keys: '?', description: 'Show this shortcuts panel' },
  { keys: 'Space', description: 'Play / pause' },
  { keys: '← / →', description: 'Seek backward / forward 5s' },
  { keys: 'Shift + ← / →', description: 'Previous / next track' },
  { keys: '↑ / ↓', description: 'Volume up / down' },
  { keys: 'M', description: 'Mute / unmute' },
  { keys: 'S', description: 'Toggle shuffle' },
  { keys: 'R', description: 'Cycle repeat mode' },
  { keys: 'Ctrl/Cmd + F', description: 'Focus search' },
  { keys: 'Alt + F4', description: 'Close window' }
]

/** Input types that take no text: shortcuts (Space) still apply on them. */
const NON_TEXT_INPUTS = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file'])

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has((el as HTMLInputElement).type)
  return tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

/** Open menus / dialogs / listboxes own their keyboard (Space selects an item there). */
function isInsideWidget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  return Boolean(
    el.closest('[role="menu"],[role="menubar"],[role="dialog"],[role="alertdialog"],[role="listbox"],[role="combobox"]')
  )
}

export function useGlobalShortcuts(onShowHelp?: () => void): void {
  const helpRef = useRef(onShowHelp)
  useEffect(() => {
    helpRef.current = onShowHelp
  }, [onShowHelp])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return
      if (isTypingTarget(e.target)) {
        // Only Ctrl/Cmd+F (focus search) is allowed to fire while typing
        // elsewhere; everything else would fight with normal text entry.
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
          e.preventDefault()
          document.querySelector<HTMLInputElement>('[data-search-input]')?.focus()
        }
        return
      }
      if (isInsideWidget(e.target)) return
      // Ctrl+S / Ctrl+R / Alt+M etc. are not player shortcuts (Ctrl+F is
      // handled below); only Shift may accompany them (Shift+arrows).
      if ((e.ctrlKey || e.metaKey || e.altKey) && e.key.toLowerCase() !== 'f') return
      // Arrow keys on a focused slider move that slider natively.
      const onSlider = e.target instanceof HTMLInputElement && e.target.type === 'range'
      if (onSlider && e.key.startsWith('Arrow')) return
      const player = usePlayer.getState()
      switch (e.key) {
        case '?':
          helpRef.current?.()
          break
        case ' ':
          // preventDefault also stops a focused button (e.g. Next, clicked
          // earlier) from being "clicked" by the same Space press.
          e.preventDefault()
          // Holding Space auto-repeats keydown: toggle once per press.
          if (e.repeat) break
          player.toggle()
          break
        case 'ArrowLeft':
          if (e.repeat && e.shiftKey) break
          if (e.shiftKey) player.previous()
          else player.seek(Math.max(0, player.currentTime - 5))
          break
        case 'ArrowRight':
          if (e.repeat && e.shiftKey) break
          if (e.shiftKey) player.next()
          else {
            const t = player.currentTime + 5
            // Unknown duration (still loading): don't clamp to 0 and rewind.
            player.seek(player.duration > 0 ? Math.min(player.duration, t) : t)
          }
          break
        case 'ArrowUp':
          e.preventDefault()
          player.setVolume(Math.min(1, player.volume + 0.05))
          break
        case 'ArrowDown':
          e.preventDefault()
          player.setVolume(Math.max(0, player.volume - 0.05))
          break
        case 'm':
        case 'M':
          if (e.repeat) break
          player.toggleMute()
          break
        case 's':
        case 'S':
          if (e.repeat) break
          player.toggleShuffle()
          break
        case 'r':
        case 'R':
          if (e.repeat) break
          player.cycleRepeat()
          break
        case 'f':
        case 'F':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            document.querySelector<HTMLInputElement>('[data-search-input]')?.focus()
          }
          break
        default:
          return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
