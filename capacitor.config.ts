import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.cyttos.oli',
  appName: 'Oli',
  webDir: 'out/renderer-android',
  android: { allowMixedContent: false },
  plugins: {
    // Native HTTP: web-view fetch() to archive.org is not blocked by browser cross-origin rules.
    CapacitorHttp: { enabled: true }
  }
}

export default config
