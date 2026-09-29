import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * Which rows of a long list of equally tall rows need to exist: the ones on screen plus a few above and below.
 * Everything else is left out of the page (the list keeps its full height through padding), so a library of thousands
 * of songs costs the same as one of a few dozen: no long frames while scrolling and no memory growth.
 * Pure so it can be tested.
 */
export function computeWindow(
  scrollTop: number,
  listTop: number,
  viewHeight: number,
  rowHeight: number,
  count: number,
  overscan: number
): { first: number; last: number } {
  const viewTop = scrollTop - listTop
  const first = Math.max(0, Math.min(count, Math.floor(viewTop / rowHeight) - overscan))
  const last = Math.max(first, Math.min(count, Math.ceil((viewTop + viewHeight) / rowHeight) + overscan))
  return { first, last }
}

const STEP = 6

function scrollParentOf(el: HTMLElement): HTMLElement {
  let node: HTMLElement | null = el.parentElement
  while (node) {
    if (/(auto|scroll|overlay)/.test(getComputedStyle(node).overflowY)) return node
    node = node.parentElement
  }
  return document.documentElement
}

export interface RowWindow {
  first: number
  last: number
  listRef: (el: HTMLDivElement | null) => void
  /** Scrolls so that row `index` is in the middle of the screen. */
  scrollToIndex: (index: number, smooth?: boolean) => void
}

/** Windowing for a list inside a scrolling page (the list finds its scrolling parent by itself). */
export function useRowWindow(count: number, rowHeight: number, overscan = 12): RowWindow {
  const [range, setRange] = useState(() => ({ first: 0, last: Math.min(count, 40) }))
  const listEl = useRef<HTMLDivElement | null>(null)
  const parentEl = useRef<HTMLElement | null>(null)
  const frame = useRef<number | null>(null)
  const countRef = useRef(count)

  const measure = useCallback((): void => {
    const list = listEl.current
    const parent = parentEl.current
    if (!list || !parent) return
    const pr = parent.getBoundingClientRect()
    const lr = list.getBoundingClientRect()
    const listTop = lr.top - pr.top + parent.scrollTop
    const w = computeWindow(parent.scrollTop, listTop, parent.clientHeight, rowHeight, countRef.current, overscan)
    // rows are added and dropped in blocks of 6, so the list is not re-drawn for every few pixels of scrolling
    const first = Math.floor(w.first / STEP) * STEP
    const last = Math.min(countRef.current, Math.ceil(w.last / STEP) * STEP)
    setRange((r) => (r.first === first && r.last === last ? r : { first, last }))
  }, [rowHeight, overscan])

  const schedule = useCallback((): void => {
    if (frame.current != null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      measure()
    })
  }, [measure])

  const listRef = useCallback(
    (el: HTMLDivElement | null): void => {
      listEl.current = el
      if (el) {
        parentEl.current = scrollParentOf(el)
        schedule()
        // the page around the list may still be settling (fonts, header): look again shortly
        setTimeout(schedule, 250)
      }
    },
    [schedule]
  )

  useLayoutEffect(() => {
    countRef.current = count
    measure()
  }, [count, measure])

  useEffect(() => {
    const parent = parentEl.current
    if (!parent) return
    const target: EventTarget = parent === document.documentElement ? window : parent
    target.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      target.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      if (frame.current != null) cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }, [schedule, count])

  const scrollToIndex = useCallback(
    (index: number, smooth = true): void => {
      const list = listEl.current
      const parent = parentEl.current
      if (!list || !parent) return
      const pr = parent.getBoundingClientRect()
      const lr = list.getBoundingClientRect()
      const listTop = lr.top - pr.top + parent.scrollTop
      const top = Math.max(0, listTop + index * rowHeight - parent.clientHeight / 2 + rowHeight / 2)
      // a long way is crossed at once (a smooth scroll over thousands of rows takes seconds)
      const near = Math.abs(top - parent.scrollTop) < parent.clientHeight * 4
      parent.scrollTo({ top, behavior: smooth && near ? 'smooth' : 'auto' })
    },
    [rowHeight]
  )

  return { first: Math.min(range.first, count), last: Math.min(range.last, count), listRef, scrollToIndex }
}
