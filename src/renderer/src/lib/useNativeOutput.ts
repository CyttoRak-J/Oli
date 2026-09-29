import { useEffect, useState } from 'react'
import { getNativeAudio, type NativeOutputInfo } from '../platform/nativeAudio'
import { usePlayer } from '../store/player'

/**
 * Live report from the native player about what reaches the hardware (Android only; null elsewhere).
 * Refreshed when the song or play state changes, when Android says the output changed, and on demand.
 */
export function useNativeOutput(): { info: NativeOutputInfo | null; refresh: () => void; native: boolean } {
  const [info, setInfo] = useState<NativeOutputInfo | null>(null)
  const currentId = usePlayer((s) => s.current?.id)
  const status = usePlayer((s) => s.status)
  const [tick, setTick] = useState(0)
  const audio = getNativeAudio()

  useEffect(() => {
    if (!audio) return
    let alive = true
    const load = (): void => {
      audio
        .getOutputInfo()
        .then((i) => alive && setInfo(i))
        .catch(() => undefined)
    }
    // The decoder and the output track appear a moment after the song starts.
    const t1 = setTimeout(load, 400)
    const t2 = setTimeout(load, 1500)
    const onOutput = (e: Event): void => setInfo((e as CustomEvent<NativeOutputInfo>).detail)
    audio.addEventListener('nativeoutput', onOutput)
    return () => {
      alive = false
      clearTimeout(t1)
      clearTimeout(t2)
      audio.removeEventListener('nativeoutput', onOutput)
    }
  }, [audio, currentId, status === 'playing', tick]) // eslint-disable-line react-hooks/exhaustive-deps

  return { info, refresh: () => setTick((n) => n + 1), native: audio != null }
}
