import { getMediaBase } from './ipc'
import { deviceFileUrl, shellPlatform } from './platform'
import { getNativePlugin } from '../platform/nativeAudio'

let base = ''

/** Ask main for the local media server's address (call once before playing). */
export async function initMedia(): Promise<void> {
  try {
    base = (await getMediaBase()) || ''
  } catch {
    base = ''
  }
}

/**
 * URL the audio element uses for a local file. The media server answers
 * Range requests properly, which is what makes seeking (progress bar, resume
 * after pause) work; the old custom protocol is only a fallback.
 */
export function localMediaUrl(filePath: string): string {
  // Android: the native player opens the file itself; without it (a browser test) the web view serves the file.
  if (shellPlatform() !== 'desktop') return getNativePlugin() ? filePath : deviceFileUrl(filePath)
  return base
    ? `${base}${encodeURIComponent(filePath)}`
    : `cyttos-local://file/${encodeURIComponent(filePath)}`
}
