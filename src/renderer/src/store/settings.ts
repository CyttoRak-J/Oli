import { create } from 'zustand'
import type { AppSettings } from '@shared/types'
import { getSettings, setSettings as persistSettings, on } from '../lib/ipc'
import { IPC } from '@shared/ipc'

interface SettingsState {
  settings: AppSettings | null
  loaded: boolean
  load: () => Promise<void>
  set: (patch: Partial<AppSettings>) => Promise<void>
  subscribe: () => () => void
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: null,
  loaded: false,

  async load(): Promise<void> {
    try {
      const settings = await getSettings()
      set({ settings, loaded: true })
    } catch {
      set({ loaded: true })
    }
  },

  async set(patch: Partial<AppSettings>): Promise<void> {
    const settings = await persistSettings(patch)
    set({ settings })
  },

  subscribe(): () => void {
    return on<Partial<AppSettings>>(IPC.onSettingsChanged, (patch) => {
      const current = get().settings
      if (current) set({ settings: { ...current, ...patch } })
    })
  }
}))

/** Read a setting with its default fallback before the store has loaded. */
export function settingOr<K extends keyof AppSettings>(
  state: SettingsState,
  key: K
): AppSettings[K] | undefined {
  return state.settings?.[key]
}