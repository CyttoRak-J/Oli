import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// FolderScope.java (a picked music folder -> what MediaStore filters on) is plain Java: compile it with the PC's JDK.
const hasJdk = spawnSync('javac', ['-version']).status === 0
const repo = path.resolve(__dirname, '..')
let work = ''

function scope(...ids: string[]): string[] {
  return execFileSync('java', ['-cp', path.join(work, 'classes'), 'com.cyttos.oli.FolderCli', ...ids], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean)
}

describe.skipIf(!hasJdk)('picked music folder (compiled with the PC JDK)', () => {
  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'oli-folder-'))
    fs.mkdirSync(path.join(work, 'classes'))
    execFileSync('javac', [
      '-d',
      path.join(work, 'classes'),
      path.join(repo, 'android/app/src/main/java/com/cyttos/oli/FolderScope.java'),
      path.join(repo, 'scripts/android-tags/com/cyttos/oli/FolderCli.java')
    ])
  })
  afterAll(() => fs.rmSync(work, { recursive: true, force: true }))

  it('reads a folder on the phone storage', () => {
    expect(scope('primary:Music/Flac')[0]).toBe(
      'volume=primary path=Music/Flac media=external_primary like=Music/Flac/% data=/storage/emulated/0/Music/Flac/% label=Music/Flac'
    )
  })

  it('reads a folder on a memory card and the whole card', () => {
    expect(scope('1A2B-3C4D:Music')[0]).toBe(
      'volume=1A2B-3C4D path=Music media=1a2b-3c4d like=Music/% data=/storage/emulated/0/Music/% label=Card 1A2B-3C4D: Music'
    )
    const [root, phone] = scope('1A2B-3C4D:', 'primary:')
    expect(root).toContain('path= ')
    expect(root).toContain('like=%')
    expect(root).toContain('label=Card 1A2B-3C4D')
    expect(phone).toContain('label=Phone storage')
  })

  it('makes % and _ in folder names literal and trims slashes', () => {
    const [a, b] = scope('primary:My_Music/100%/', 'primary:/Music//Flac/')
    expect(a).toContain('like=My\\_Music/100\\%/%')
    expect(b).toContain('path=Music/Flac ')
  })

  it('refuses things that are not folders on a storage volume', () => {
    expect(scope('downloads', 'msf:1234', ':x')).toEqual(['none', 'none', 'none'])
  })
})
