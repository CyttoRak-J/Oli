import { create } from 'zustand'
import { usePlayer } from './player'

/**
 * ADDED: Sleep timer. Pauses playback after N minutes. Kept entirely in the
 * renderer (no IPC/main process involvement needed) since all it has to do
 * is call the player store's existing pause() when the countdown hits zero.
 */

interface SleepTimerState {
  endAt: number | null
  minutesLabel: number | null
  start: (minutes: number) => void
  cancel: () => void
  remainingSeconds: () => number
}

let intervalHandle: ReturnType<typeof setInterval> | null = null

export const useSleepTimer = create<SleepTimerState>((set, get) => ({
  endAt: null,
  minutesLabel: null,

  start(minutes: number) {
    if (intervalHandle) clearInterval(intervalHandle)
    const endAt = Date.now() + minutes * 60_000
    set({ endAt, minutesLabel: minutes })
    intervalHandle = setInterval(() => {
      const { endAt: currentEnd } = get()
      if (currentEnd !== null && Date.now() >= currentEnd) {
        usePlayer.getState().pause()
        get().cancel()
      }
    }, 1000)
  },

  cancel() {
    if (intervalHandle) {
      clearInterval(intervalHandle)
      intervalHandle = null
    }
    set({ endAt: null, minutesLabel: null })
  },

  remainingSeconds() {
    const { endAt } = get()
    if (endAt === null) return 0
    return Math.max(0, Math.round((endAt - Date.now()) / 1000))
  }
}))
