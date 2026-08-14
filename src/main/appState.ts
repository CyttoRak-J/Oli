import { app } from 'electron'

/**
 * Tracks explicit-quit state in one place: the module flag (for code that
 * must not import Electron's App typing) and the augmented `app.isQuitting`
 * mirror are set together so they can never diverge.
 */
let quitting = false

export function markQuitting(): void {
  quitting = true
  app.isQuitting = true
}

export function isQuitting(): boolean {
  return quitting
}