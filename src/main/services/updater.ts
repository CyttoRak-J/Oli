import { shell } from 'electron'
import { getLogger } from './logger'
import { APP_VERSION } from '@shared/constants'

export interface UpdateStatus {
  checked: boolean
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  updateUrl: string | null
  error: string | null
  checkedAt: number
}

const REPO_API = 'https://api.github.com/repos/CyttosPlay/CyttosPlay/releases/latest'
const AUTO_INTERVAL_MS = 6 * 3600_000

/**
 * Lightweight update checker against the project's GitHub Releases.
 * Downloads are never automated — the user is pointed to the release page,
 * which keeps the update path safe and legal.
 */
export class UpdaterService {
  private lastChecked = 0

  async check(auto = false): Promise<UpdateStatus> {
    const now = Date.now()
    if (auto && now - this.lastChecked < AUTO_INTERVAL_MS) {
      return { checked: true, currentVersion: APP_VERSION, latestVersion: null, updateAvailable: false, updateUrl: null, error: null, checkedAt: this.lastChecked }
    }
    this.lastChecked = now
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      const res = await fetch(REPO_API, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: controller.signal
      })
      clearTimeout(timer)
      if (!res.ok) {
        return this.status(res.status === 404 ? 'No releases published yet' : `HTTP ${res.status}`)
      }
      const body = (await res.json()) as { tag_name?: string; html_url?: string }
      const tag = body.tag_name?.replace(/^v/, '') ?? null
      const newer = tag ? compareVersions(tag, APP_VERSION) > 0 : false
      return {
        checked: true,
        currentVersion: APP_VERSION,
        latestVersion: tag,
        updateAvailable: newer,
        updateUrl: newer ? (body.html_url ?? null) : null,
        error: null,
        checkedAt: now
      }
    } catch (err) {
      getLogger().debug('Update check failed', err)
      return this.status((err as Error).message)
    }
  }

  private status(error: string | null): UpdateStatus {
    return {
      checked: !error,
      currentVersion: APP_VERSION,
      latestVersion: null,
      updateAvailable: false,
      updateUrl: null,
      error,
      checkedAt: Date.now()
    }
  }

  openReleasePage(url: string | null): void {
    const target = url ?? 'https://github.com/CyttosPlay/CyttosPlay/releases'
    void shell.openExternal(target)
  }
}

function versionParse(v: string): number[] {
  return v.split('.').map((part) => {
    const n = Number.parseInt(part.replace(/[^0-9]/g, '') || '0', 10)
    return Number.isFinite(n) ? n : 0
  })
}

function compareVersions(a: string, b: string): number {
  const av = versionParse(a)
  const bv = versionParse(b)
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const diff = (av[i] ?? 0) - (bv[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}