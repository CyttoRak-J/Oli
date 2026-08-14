import 'electron'

declare global {
  namespace Electron {
    interface App {
      /** True once the user explicitly asked to quit (tray Quit, app.quit()). */
      isQuitting: boolean
    }
  }
}

export {}