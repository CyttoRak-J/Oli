/// <reference types="vite/client" />

export interface CyttoBridge {
  platform: string
  versions: { electron: string; chrome: string; node: string }
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  send: (channel: string, ...args: unknown[]) => void
  on: (channel: string, listener: (...args: unknown[]) => void) => () => void
  once: (channel: string, listener: (...args: unknown[]) => void) => () => void
}

declare global {
  /** true in the Android/web build, false in the desktop build (set in the Vite configs). */
  const __OLI_WEB__: boolean

  interface Window {
    cytto: CyttoBridge
  }
}

export {}
