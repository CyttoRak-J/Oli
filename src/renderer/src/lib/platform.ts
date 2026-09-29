/** Which shell the UI runs in: the Electron desktop app, the Android app, or a plain browser. */
export type ShellPlatform = 'desktop' | 'android' | 'web'

export function shellPlatform(): ShellPlatform {
  if (typeof window === 'undefined') return 'desktop' // unit tests run in plain Node
  const p = window.cytto?.platform
  if (p === 'android') return 'android'
  if (p === 'web') return 'web'
  return 'desktop'
}

/** Phone layout: bottom navigation, no custom title bar, no desktop-only windows. */
export const isMobileShell = (): boolean => shellPlatform() !== 'desktop'

/** URL the audio element can load for a file that Capacitor saved on the phone. */
export function deviceFileUrl(uri: string): string {
  const cap = (window as unknown as { Capacitor?: { convertFileSrc?: (u: string) => string } }).Capacitor
  return cap?.convertFileSrc ? cap.convertFileSrc(uri) : uri
}
