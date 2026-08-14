import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Renders only the first `step` items of a large list and grows the visible
 * window as the sentinel element scrolls into view. Keeps big libraries
 * (hundreds/thousands of rows) cheap to mount and scroll.
 */
export function useIncrementalRender(count: number, step = 200): {
  visible: number
  sentinelRef: (el: HTMLElement | null) => void
} {
  const [visible, setVisible] = useState(() => Math.min(count, step))
  const [prevCount, setPrevCount] = useState(count)
  const observerRef = useRef<IntersectionObserver | null>(null)
  const sentinelElRef = useRef<HTMLElement | null>(null)

  // Clamp when the list shrinks (filters/letter changes); if the list went
  // empty and data arrives again (e.g. fast typing swaps queries), restore
  // the initial window instead of staying stuck at 0.
  if (prevCount !== count) {
    setPrevCount(count)
    setVisible((v) => {
      if (count === 0) return 0
      if (v === 0) return Math.min(count, step)
      return Math.min(v, count)
    })
  }

  useEffect(() => {
    observerRef.current?.disconnect()
    const el = sentinelElRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisible((v) => Math.min(count, v + step))
        }
      },
      { rootMargin: '600px 0px' }
    )
    observerRef.current = observer
    observer.observe(el)
    return () => observer.disconnect()
  }, [count, step])

  const sentinelRef = useCallback((el: HTMLElement | null) => {
    sentinelElRef.current = el
  }, [])

  return { visible, sentinelRef }
}
