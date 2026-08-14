import { Tray, Menu, nativeImage, app } from 'electron'
import * as path from 'node:path'
import { APP_NAME } from '@shared/constants'
import { markQuitting } from './appState'
import type { PlaybackSnapshot } from './services/playerState'

export interface TrayHandlers {
  playPause: () => void
  next: () => void
  previous: () => void
  show: () => void
}

export class TrayManager {
  private tray: Tray | null = null
  private snapshot: PlaybackSnapshot | null = null

  constructor(private handlers: TrayHandlers) {}

  create(): void {
    if (this.tray) return
    const icon = nativeImage
      .createFromPath(path.join(__dirname, '../../build/tray-16.png'))
      .resize({ width: 16, height: 16 })
    if (icon.isEmpty()) return
    this.tray = new Tray(icon)
    this.tray.setToolTip(APP_NAME)
    this.tray.setContextMenu(this.buildMenu())
    this.tray.on('double-click', () => this.handlers.show())
  }

  update(snapshot: PlaybackSnapshot): void {
    this.snapshot = snapshot
    if (!this.tray) return
    const playing =
      (snapshot.status === 'playing' || snapshot.status === 'loading') && snapshot.songId
    this.tray.setToolTip(playing ? `Now playing in ${APP_NAME}` : APP_NAME)
    this.tray.setContextMenu(this.buildMenu())
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }

  private buildMenu(): Menu {
    const snapshot = this.snapshot
    const isPlaying = snapshot?.status === 'playing' || snapshot?.status === 'loading'
    const label = snapshot?.songId
      ? isPlaying
        ? 'Pause'
        : 'Play'
      : 'Play / Pause'
    return Menu.buildFromTemplate([
      { label: 'Show Oli', click: () => this.handlers.show() },
      { type: 'separator' },
      { label: 'Previous', click: () => this.handlers.previous() },
      { label, click: () => this.handlers.playPause() },
      { label: 'Next', click: () => this.handlers.next() },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          markQuitting()
          app.quit()
        }
      }
    ])
  }
}
