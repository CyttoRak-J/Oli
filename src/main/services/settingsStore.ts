import { EventEmitter } from 'node:events'
import type { Database } from './database'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { AppSettings } from '@shared/types'

const FLAT_DEFAULTS = flatten(DEFAULT_SETTINGS)

function flatten(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(obj)) {
    const k = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flatten(value as Record<string, unknown>, k))
    } else {
      out[k] = JSON.stringify(value)
    }
  }
  return out
}

export class SettingsStore extends EventEmitter {
  private cache = new Map<string, string>()

  constructor(private db: Database) {
    super()
  }

  load(): void {
    this.cache.clear()
    for (const row of this.db.all<{ key: string; value: string }>(
      'SELECT key, value FROM settings'
    )) {
      this.cache.set(row.key, row.value)
    }
  }

  get<K extends keyof AppSettings>(key: K): AppSettings[K] {
    const raw = this.cache.get(key)
    if (raw === undefined) return this.defaults(key)
    try {
      return JSON.parse(raw) as AppSettings[K]
    } catch {
      return this.defaults(key)
    }
  }

  getBoolean(key: keyof AppSettings): boolean {
    return Boolean(this.get(key))
  }

  private defaults<K extends keyof AppSettings>(key: K): AppSettings[K] {
    const raw = FLAT_DEFAULTS[key as string]
    if (raw === undefined) return undefined as unknown as AppSettings[K]
    try {
      return JSON.parse(raw) as AppSettings[K]
    } catch {
      return undefined as unknown as AppSettings[K]
    }
  }

  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    const raw = JSON.stringify(value)
    this.cache.set(key, raw)
    this.db.run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, raw]
    )
    this.emit('changed', { key, value })
  }

  setMany(entries: Partial<AppSettings>): void {
    const tx = this.db.transaction()
    try {
      for (const [key, value] of Object.entries(entries)) {
        const raw = JSON.stringify(value)
        this.cache.set(key, raw)
        this.db.run(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          [key, raw]
        )
      }
      tx.commit()
    } catch (err) {
      tx.rollback()
      throw err
    }
    this.emit('changed', entries)
  }

  all(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(FLAT_DEFAULTS)) {
      const value = this.get(key as keyof AppSettings)
      const parts = key.split('.')
      const target = parts.length > 1 ? parts.slice(0, -1).reduce<Record<string, unknown>>((acc, p) => {
        acc[p] = acc[p] ?? {}
        return acc[p] as Record<string, unknown>
      }, out) : out
      target[parts[parts.length - 1]] = value
    }
    return out
  }
}