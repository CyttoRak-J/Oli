import { resolve } from 'path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Web build of the UI for the Android app (Capacitor) and for trying the UI in a browser.
// The desktop app is built by electron.vite.config.ts; both use the same screens.
//
// The Android app runs the desktop app's own services (database, library queries, playlists, favorites, queue, history...)
// inside the web view. Those files import a few Node modules, which are replaced here by small browser stand-ins.
const shim = (name: string): string => resolve('src/renderer/src/platform/shims', name)

/** services/logger.ts writes log files with node:fs; in the phone app it is replaced by a console logger. */
function webLogger(): Plugin {
  return {
    name: 'oli-web-logger',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !/[\\/]logger$/.test(source)) return null
      if (!importer.replace(/\\/g, '/').includes('/src/main/')) return null
      return shim('logger.ts')
    }
  }
}

/** The database (SQLite as WebAssembly) needs 'wasm-unsafe-eval' in the page's Content-Security-Policy. Phone build only. */
function webCsp(): Plugin {
  return {
    name: 'oli-web-csp',
    transformIndexHtml(html) {
      const before = "script-src 'self' cyttos-vendor:"
      if (!html.includes(before)) throw new Error('index.html CSP changed: update the oli-web-csp plugin')
      return html.replace(before, "script-src 'self' 'wasm-unsafe-eval' cyttos-vendor:")
    }
  }
}

/** Test builds only (OLI_TEST_HOOKS=1): expose the player store as window.__oliPlayer so a test window can drive the real app. */
function testHooks(): Plugin {
  return {
    name: 'oli-test-hooks',
    transform(code, id) {
      if (!process.env.OLI_TEST_HOOKS || !/\/store\/player\.ts$/.test(id)) return null
      return `${code}
;(globalThis).__oliPlayer = usePlayer
`
    }
  }
}

export default defineConfig({
  root: 'src/renderer',
  base: './',
  define: { __OLI_WEB__: 'true' },
  resolve: {
    alias: [
      { find: '@renderer', replacement: resolve('src/renderer/src') },
      { find: '@shared', replacement: resolve('src/shared') },
      { find: '@main', replacement: resolve('src/main') },
      { find: 'node:events', replacement: shim('events.ts') },
      { find: 'node:path', replacement: shim('path.ts') },
      { find: 'node:crypto', replacement: shim('crypto.ts') },
      { find: 'node:fs', replacement: shim('fs.ts') }
    ]
  },
  plugins: [webLogger(), webCsp(), testHooks(), react(), tailwindcss()],
  build: {
    outDir: resolve(process.env.OLI_OUT_DIR || 'out/renderer-android'),
    emptyOutDir: true,
    rollupOptions: { input: resolve('src/renderer/index.html') }
  }
})
