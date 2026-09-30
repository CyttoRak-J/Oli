import { useEffect, useRef, useState } from 'react'

/**
 * Behaviour of a seek slider, shared by the player bar and the Now Playing page.
 * - The value shown while dragging (`preview`) comes from the slider's `input` events.
 * - The seek is committed ONCE per gesture, with the LAST value the person moved to, when the gesture ends (mouse or
 *   finger up, touch cancelled, the browser's `change` event, arrow keys). A gesture that never moved the slider
 *   commits nothing: on the phone the browser can cancel a touch at its very start, and committing the slider's
 *   untouched value then restarted the song from 0:00.
 */
export function useSeekSlider(commit: (value: number) => void): {
  ref: React.RefObject<HTMLInputElement | null>
  preview: number | null
  props: {
    onInput: (e: React.FormEvent<HTMLInputElement>) => void
    onPointerUp: () => void
    onPointerCancel: () => void
    onTouchEnd: () => void
    onKeyUp: (e: React.KeyboardEvent<HTMLInputElement>) => void
  }
} {
  const ref = useRef<HTMLInputElement | null>(null)
  const [preview, setPreview] = useState<number | null>(null)
  const moved = useRef<number | null>(null)
  const latest = useRef(commit)
  useEffect(() => {
    latest.current = commit
  })

  const end = (): void => {
    const v = moved.current
    moved.current = null
    if (v === null || !Number.isFinite(v)) return
    latest.current(v)
    setPreview(null)
  }
  const endRef = useRef(end)
  useEffect(() => {
    endRef.current = end
  })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onChange = (): void => endRef.current()
    el.addEventListener('change', onChange)
    return () => el.removeEventListener('change', onChange)
  })

  return {
    ref,
    preview,
    props: {
      onInput: (e) => {
        const v = Number((e.target as HTMLInputElement).value)
        if (!Number.isFinite(v)) return
        moved.current = v
        setPreview(v)
      },
      onPointerUp: end,
      onPointerCancel: end,
      onTouchEnd: end,
      onKeyUp: (e) => {
        if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') end()
      }
    }
  }
}
