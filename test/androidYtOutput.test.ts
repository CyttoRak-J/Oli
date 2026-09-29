import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// YtDlpOutput.java (reading yt-dlp's progress lines, escaping tag values for --parse-metadata) is plain Java:
// compile it with the PC's JDK. The escaping rule was also checked against the real yt-dlp 2026.08.19.
const hasJdk = spawnSync('javac', ['-version']).status === 0
const repo = path.resolve(__dirname, '..')
let work = ''

function run(lines: string[]): string[] {
  const file = path.join(work, `in-${Math.random().toString(36).slice(2)}.txt`)
  fs.writeFileSync(file, lines.join('\n'), 'utf8')
  return execFileSync('java', ['-cp', path.join(work, 'classes'), 'com.cyttos.oli.YtCli', file], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean)
}

describe.skipIf(!hasJdk)('yt-dlp output reader (compiled with the PC JDK)', () => {
  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'oli-yt-'))
    fs.mkdirSync(path.join(work, 'classes'))
    execFileSync('javac', [
      '-d',
      path.join(work, 'classes'),
      path.join(repo, 'android/app/src/main/java/com/cyttos/oli/YtDlpOutput.java'),
      path.join(repo, 'scripts/android-tags/com/cyttos/oli/YtCli.java')
    ])
  })
  afterAll(() => fs.rmSync(work, { recursive: true, force: true }))

  it('reads the progress lines yt-dlp prints', () => {
    const out = run([
      '[download]   0.0% of    3.45MiB at  Unknown B/s ETA Unknown',
      '[download]  12.5% of    4.00MiB at    1.00MiB/s ETA 00:02',
      '[download]  45.6% of ~   5.00MiB at  800.00KiB/s ETA 01:04 (frag 3/10)',
      '[download] 100% of    3.45MiB in 00:00:02 at 1.50MiB/s',
      '[download]  99.9% of 2.00GiB at 10.00MiB/s ETA 00:00'
    ])
    expect(out[0]).toBe('pct=0.0 total=3617587 done=0 speed=0 eta=-1')
    expect(out[1]).toBe('pct=12.5 total=4194304 done=524288 speed=1048576 eta=2')
    expect(out[2]).toBe('pct=45.6 total=5242880 done=2390753 speed=819200 eta=64')
    expect(out[3]).toMatch(/^pct=100\.0 total=3617587 done=3617587 speed=0/)
    expect(out[4]).toMatch(/^pct=99\.9 total=2147483648 /)
  })

  it('ignores everything else', () => {
    const out = run([
      '[download] Destination: /x/y.m4a',
      '[youtube] abc: Downloading webpage',
      '[Metadata] Adding metadata to "/x/y.m4a"',
      '',
      '[download]  50.0% of unknown size'
    ])
    expect(out.slice(0, 3)).toEqual(['none', 'none', 'none'])
  })

  it('escapes tag values the way yt-dlp reads them', () => {
    const out = run(['META Plain', 'META 50% Off: "Live"', 'META A:B:C', 'META has \\ backslash', 'META ends with \\'])
    expect(out).toEqual([
      'meta=Plain',
      'meta=50%% Off\\: "Live"',
      'meta=A\\:B\\:C',
      'meta=has \\ backslash',
      'meta=ends with ' // a trailing backslash would escape the separating colon, so it is dropped
    ])
  })
})
