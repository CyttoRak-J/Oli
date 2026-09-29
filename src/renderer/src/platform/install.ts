/**
 * The desktop app gets `window.cytto` from the Electron preload. Anywhere else (the Android app, or a plain
 * browser during development) this installs a backend that runs inside the web view instead.
 * Loaded lazily so the desktop build never runs it.
 */
export async function installPlatform(): Promise<void> {
  if (!__OLI_WEB__ || typeof window === 'undefined' || window.cytto) return
  const cap = (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor
  const platform = cap?.getPlatform?.() === 'android' ? 'android' : 'web'
  const { installWebBackend } = await import('./webBackend')
  await installWebBackend(platform)
}
