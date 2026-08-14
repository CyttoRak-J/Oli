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
  interface Window {
    cytto: CyttoBridge
  }
}

export {}
