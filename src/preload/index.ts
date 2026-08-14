import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'

export interface CyttoApi {
  platform: NodeJS.Platform
  versions: { electron: string; chrome: string; node: string }
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  send: (channel: string, ...args: unknown[]) => void
  on: (channel: string, listener: (...args: unknown[]) => void) => () => void
  once: (channel: string, listener: (...args: unknown[]) => void) => () => void
}

const ALLOWED = new Set<string>(Object.values(IPC))

const api: CyttoApi = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },
  invoke: (channel, ...args) => {
    if (!ALLOWED.has(channel)) return Promise.reject(new Error(`Blocked IPC channel: ${channel}`))
    return ipcRenderer.invoke(channel, ...args)
  },
  send: (channel, ...args) => {
    if (!ALLOWED.has(channel)) return
    ipcRenderer.send(channel, ...args)
  },
  on: (channel, listener) => {
    if (!ALLOWED.has(channel)) return () => undefined
    const wrapped = (_e: Electron.IpcRendererEvent, ...args: unknown[]): void => listener(...args)
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  },
  once: (channel, listener) => {
    if (!ALLOWED.has(channel)) return () => undefined
    const wrapped = (_e: Electron.IpcRendererEvent, ...args: unknown[]): void => listener(...args)
    ipcRenderer.once(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('cytto', api)