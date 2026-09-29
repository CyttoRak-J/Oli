import { describe, expect, it } from 'vitest'
import { checkAgainstReleases, checkAndroidUpdate, compareVersions, parseVersion } from '../src/renderer/src/platform/androidUpdate'

const rel = (tag: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  tag_name: tag,
  html_url: `https://github.com/CyttoRak-J/Oli/releases/tag/${tag}`,
  prerelease: tag.startsWith('android'),
  ...extra
})

describe('Android update check', () => {
  it('compares versions numerically, not as text', () => {
    expect(parseVersion('android-v0.10.2')).toEqual([0, 10, 2])
    expect(parseVersion('nonsense')).toBeNull()
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('0.6.0', '0.6.0')).toBe(0)
    expect(compareVersions('0.5.9', '0.6.0')).toBeLessThan(0)
  })

  it('finds the newest android release and ignores the desktop ones, drafts and odd tags', () => {
    const releases = [rel('v1.1.0', { prerelease: false }), rel('android-v0.5.0'), rel('android-v0.6.0'), rel('android-v0.7.0', { draft: true }), rel('android-v0.6.0-test'), rel('android-v0.4.0')]
    const s = checkAgainstReleases(releases, '0.5.0', 123)
    expect(s).toMatchObject({ checked: true, currentVersion: '0.5.0', latestVersion: '0.6.0', updateAvailable: true, error: null, checkedAt: 123 })
    expect(s.updateUrl).toBe('https://github.com/CyttoRak-J/Oli/releases/tag/android-v0.6.0')
  })

  it('says nothing is new when the installed version is the newest (or newer)', () => {
    expect(checkAgainstReleases([rel('android-v0.6.0')], '0.6.0')).toMatchObject({ updateAvailable: false, updateUrl: null, latestVersion: '0.6.0' })
    expect(checkAgainstReleases([rel('android-v0.6.0')], '0.7.0').updateAvailable).toBe(false)
    expect(checkAgainstReleases([], '0.6.0')).toMatchObject({ updateAvailable: false, latestVersion: null })
  })

  it('reports network trouble instead of throwing', async () => {
    const ok = (body: unknown, status = 200): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
    expect(await checkAndroidUpdate('0.5.0', ok([rel('android-v0.6.0')]))).toMatchObject({ updateAvailable: true, latestVersion: '0.6.0' })
    expect((await checkAndroidUpdate('0.5.0', ok({}, 403))).error).toMatch(/limiting/)
    expect((await checkAndroidUpdate('0.5.0', ok({}, 500))).error).toBe('HTTP 500')
    const broken = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect((await checkAndroidUpdate('0.5.0', broken)).error).toBe('offline')
    expect((await checkAndroidUpdate('0.5.0', ok({ not: 'a list' }))).updateAvailable).toBe(false)
  })
})
