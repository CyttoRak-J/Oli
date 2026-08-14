import type { Database } from './database'
import { ANALYTICS_KEYS } from '@shared/constants'

type MetricKey = (typeof ANALYTICS_KEYS)[keyof typeof ANALYTICS_KEYS]

/**
 * Local, private usage statistics. Nothing is ever transmitted anywhere;
 * the numbers power the insights on the Home page (plays, scans, favorites…).
 */
export class AnalyticsService {
  constructor(private db: Database) {}

  increment(key: MetricKey, amount = 1): void {
    this.upsert(key, amount, true)
  }

  set(key: string, value: number): void {
    this.upsert(key, value, false)
  }

  /** Shared upsert: `add` accumulates into the stored value, otherwise it replaces it. */
  private upsert(key: string, value: number, add: boolean): void {
    try {
      this.db.run(
        `INSERT INTO statistics (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = ${add ? 'value + ' : ''}excluded.value, updated_at = excluded.updated_at`,
        [key, value, Date.now()]
      )
    } catch {
      // ignore
    }
  }

  get(key: string): number {
    try {
      const row = this.db.get<{ value: number }>(
        'SELECT value FROM statistics WHERE key = ?',
        [key]
      )
      return Number(row?.value ?? 0)
    } catch {
      return 0
    }
  }

  all(): Record<string, number> {
    try {
      const rows = this.db.all<{ key: string; value: number }>('SELECT key, value FROM statistics')
      return Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]))
    } catch {
      return {}
    }
  }

  incrementLaunch(): void {
    this.increment(ANALYTICS_KEYS.appLaunches)
  }
}