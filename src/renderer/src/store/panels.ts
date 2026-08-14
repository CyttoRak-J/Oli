import { create } from 'zustand'

export type PanelKind = 'queue' | 'history' | 'lyrics' | 'nowplaying'

interface PanelsState {
  panel: PanelKind | null
  open: (panel: PanelKind) => void
  toggle: (panel: PanelKind) => void
  close: () => void
}

/** Right-hand overlay panels (Queue / History / Lyrics / Now Playing). */
export const usePanels = create<PanelsState>((set) => ({
  panel: null,
  open: (panel) => set({ panel }),
  toggle: (panel) => set((s) => ({ panel: s.panel === panel ? null : panel })),
  close: () => set({ panel: null })
}))
