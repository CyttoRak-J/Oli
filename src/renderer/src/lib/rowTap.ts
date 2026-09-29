import type { MouseEvent } from 'react'
import { isMobileShell } from './platform'

/**
 * On a phone there is no hover and no double click: tapping a song row plays it. Taps on the row's own buttons
 * (favorite, menu, artist link, ...) keep doing what they say. Returns nothing on the desktop, where a double
 * click plays and a single click on the title opens the song's info.
 */
export function tapToPlay(play: () => void): { onClick?: (e: MouseEvent<HTMLElement>) => void } {
  if (!isMobileShell()) return {}
  return {
    onClick: (e) => {
      if ((e.target as HTMLElement).closest('button, a, input, select, textarea, [role="button"], [data-no-tap]')) return
      play()
    }
  }
}
