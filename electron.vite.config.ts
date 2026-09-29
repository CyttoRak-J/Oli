import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      outDir: 'out/main'
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      outDir: 'out/preload'
    }
  },
  renderer: {
    root: 'src/renderer',
    // The Android/web backend is not part of the desktop app (dead code, removed from the bundle).
    define: { __OLI_WEB__: 'false' },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [
      {
        // The Android/web backend (platform/webBackend.ts) is never loaded on desktop: give the desktop bundle an
        // empty stand-in so none of that code (or its SQLite wasm file) ends up in the app.
        name: 'oli-no-web-backend',
        enforce: 'pre',
        resolveId(source) {
          return source === './webBackend' ? '\0oli-no-web-backend' : null
        },
        load(id) {
          return id === '\0oli-no-web-backend' ? 'export async function installWebBackend() {}' : null
        }
      },
      react(),
      tailwindcss()
    ],
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html')
        }
      }
    }
  }
})
