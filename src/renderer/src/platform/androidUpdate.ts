/**
 * "Is there a newer Android build?" - looks at the project's GitHub releases for tags like android-v0.7.0 and compares
 * with the installed version. Nothing is downloaded or installed by itself: the owner is pointed to the release page
 * (the APK is there, with its checksum).
 */
export interface GithubRelease {
  tag_name?: string
  html_url?: string
  draft?: boolean
  prerelease?: boolean
  published_at?: string
}

export interface AndroidUpdateStatus {
  checked: boolean
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  updateUrl: string | null
  error: string | null
  checkedAt: number
}

/** [major, minor, patch] of "0.6.1" or "android-v0.6.1" (null when it is not a version). */
export function parseVersion(s: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(s)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** Positive when a is newer than b. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

export function checkAgainstReleases(releases: GithubRelease[], current: string, now = Date.now()): AndroidUpdateStatus {
  let best: { version: string; url: string | null } | null = null
  for (const r of releases) {
    if (r.draft || !r.tag_name || !/^android-v\d+\.\d+\.\d+$/.test(r.tag_name)) continue
    const version = r.tag_name.replace(/^android-v/, '')
    if (!best || compareVersions(version, best.version) > 0) best = { version, url: r.html_url ?? null }
  }
  const newer = best != null && compareVersions(best.version, current) > 0
  return {
    checked: true,
    currentVersion: current,
    latestVersion: best?.version ?? null,
    updateAvailable: newer,
    updateUrl: newer ? best!.url : null,
    error: null,
    checkedAt: now
  }
}

const RELEASES = 'https://api.github.com/repos/CyttoRak-J/Oli/releases?per_page=30'

export async function checkAndroidUpdate(current: string, fetchFn: typeof fetch = fetch): Promise<AndroidUpdateStatus> {
  const now = Date.now()
  const failed = (error: string): AndroidUpdateStatus => ({
    checked: true,
    currentVersion: current,
    latestVersion: null,
    updateAvailable: false,
    updateUrl: null,
    error,
    checkedAt: now
  })
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    const res = await fetchFn(RELEASES, { headers: { Accept: 'application/vnd.github+json' }, signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) return failed(res.status === 403 ? 'GitHub is limiting requests, try again later' : `HTTP ${res.status}`)
    const body = (await res.json()) as GithubRelease[]
    return checkAgainstReleases(Array.isArray(body) ? body : [], current, now)
  } catch (err) {
    return failed((err as Error)?.name === 'AbortError' ? 'GitHub took too long to answer' : (err as Error)?.message || 'Could not reach GitHub')
  }
}
