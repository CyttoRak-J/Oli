import * as fs from 'node:fs'
import * as path from 'node:path'
import { EventEmitter } from 'node:events'
import { getLogger } from './logger'

/**
 * Recursive folder watcher built on fs.watch (recursive is supported on
 * Windows). Bursts of events are debounced into a single "changed" signal per
 * root, and a periodic sweep emits reconciliation events to catch anything
 * fs.watch misses (network drives, some renames).
 */
export class FolderWatcher extends EventEmitter {
  private watchers = new Map<string, fs.FSWatcher>()
  private debounceTimers = new Map<string, NodeJS.Timeout>()
  private sweepTimer: NodeJS.Timeout | null = null
  private _disabled = false

  constructor(private sweepIntervalMs = 300_000) {
    super()
  }

  watchRoot(root: string): void {
    const resolved = path.resolve(root)
    if (this.watchers.has(resolved)) return
    try {
      if (!fs.statSync(resolved).isDirectory()) return
    } catch {
      return
    }
    let watcher: fs.FSWatcher
    try {
      watcher = fs.watch(resolved, { recursive: true }, (_event, filename) => {
        if (this._disabled) return
        if (!filename) return
        this.debounce(path.join(resolved, filename.toString()))
      })
    } catch (err) {
      getLogger().warn(`fs.watch failed for ${resolved}`, err)
      return
    }
    watcher.on('error', (err) => {
      getLogger().debug(`Watcher error for ${resolved}`, err)
      this.stopWatching(resolved)
    })
    this.watchers.set(resolved, watcher)
    getLogger().info(`Watching library folder: ${resolved}`)
    this.ensureSweep()
  }

  stopWatching(root: string): void {
    const resolved = path.resolve(root)
    const watcher = this.watchers.get(resolved)
    if (watcher) {
      try {
        watcher.close()
      } catch {
        // ignore
      }
      this.watchers.delete(resolved)
    }
    const timer = this.debounceTimers.get(resolved)
    if (timer) clearTimeout(timer)
    this.debounceTimers.delete(resolved)
  }

  clear(): void {
    for (const key of [...this.watchers.keys()]) this.stopWatching(key)
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
  }

  get disabled(): boolean {
    return this._disabled
  }

  set disabled(value: boolean) {
    this._disabled = value
  }

  get roots(): string[] {
    return [...this.watchers.keys()]
  }

  private debounce(fullPath: string): void {
    const root = this.findRoot(fullPath)
    if (!root) return
    const existing = this.debounceTimers.get(root)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.debounceTimers.delete(root)
      this.emit('changed', { root, file: fullPath })
    }, 700)
    this.debounceTimers.set(root, timer)
  }

  private findRoot(fullPath: string): string | null {
    const resolved = path.resolve(fullPath)
    let best: string | null = null
    for (const root of this.watchers.keys()) {
      if (isInside(resolved, root) && (!best || root.length > best.length)) best = root
    }
    return best
  }

  private ensureSweep(): void {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => {
      if (this._disabled) return
      for (const root of this.watchers.keys()) {
        if (!fs.existsSync(root)) {
          this.stopWatching(root)
          continue
        }
        this.emit('sweep', { root })
      }
    }, this.sweepIntervalMs)
    this.sweepTimer.unref?.()
  }
}

function isInside(file: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(file))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}