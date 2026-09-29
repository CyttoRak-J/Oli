import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'

export const LONGPATH_DIR = path.join(os.tmpdir(), 'cyttos-longpath')
const DIR = LONGPATH_DIR

/** Paths this long fail in Chromium's file loader and in ffmpeg on Windows (MAX_PATH = 260). */
export const LONG_PATH_LIMIT = 240

/**
 * A path Chromium and ffmpeg can open. Node itself handles very long paths,
 * so an over-long file is copied once into a short temp path and that copy
 * is used (lossless: same bytes, no transcode). Ordinary paths are returned
 * unchanged.
 */
export async function playablePath(file: string): Promise<string> {
  if (process.platform !== 'win32' || file.length < LONG_PATH_LIMIT) return file
  const st = await fsp.stat(file)
  const key = createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 20)
  const copy = path.join(DIR, key + path.extname(file).toLowerCase())
  try {
    if ((await fsp.stat(copy)).size === st.size) return copy
  } catch {
    // not copied yet
  }
  await fsp.mkdir(DIR, { recursive: true })
  const part = `${copy}.part`
  await fsp.copyFile(file, part)
  await fsp.rename(part, copy)
  return copy
}

/** Remove leftovers of interrupted copies. */
export function cleanLongPathTemp(): void {
  try {
    for (const name of fs.readdirSync(DIR)) {
      if (name.endsWith('.part')) fs.rmSync(path.join(DIR, name), { force: true })
    }
  } catch {
    // directory missing
  }
}
