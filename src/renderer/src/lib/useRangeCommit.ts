import { useEffect, useRef } from 'react'

/**
 * Calls `commit(value)` when the person finishes moving a range slider. The browser's own `change` event is the one
 * that always arrives (mouse, finger tap or drag, keyboard); pointerup alone is missed when a touch drag is cancelled.
 * (React's onChange is the `input` event, so the native event is attached here.)
 */
export function useRangeCommit(commit: (value: number) => void): React.RefObject<HTMLInputElement | null> {
  const ref = useRef<HTMLInputElement | null>(null)
  const latest = useRef(commit)
  useEffect(() => {
    latest.current = commit
  })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onChange = (): void => {
      const v = Number(el.value)
      if (Number.isFinite(v)) latest.current(v)
    }
    el.addEventListener('change', onChange)
    return () => el.removeEventListener('change', onChange)
  })
  return ref
}
