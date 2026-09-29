import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Web build of the UI for the Android app (Capacitor) and for trying the UI in a browser.
// The desktop app is built by electron.vite.config.ts; both use the same screens.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve('out/renderer-android'),
    emptyOutDir: true,
    rollupOptions: { input: resolve('src/renderer/index.html') }
  }
})
