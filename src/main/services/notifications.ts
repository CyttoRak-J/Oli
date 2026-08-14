import { Notification, shell } from 'electron'
import { getLogger } from './logger'
import { APP_NAME } from '@shared/constants'

export interface NotifyOptions {
  title: string
  body: string
  clickAction?: () => void
}

export class NotificationService {
  private clickHandler: (() => void) | null = null

  show(opts: NotifyOptions): void {
    if (!Notification.isSupported()) return
    try {
      const notification = new Notification({
        title: opts.title,
        body: opts.body,
        silent: false
      })
      this.clickHandler = opts.clickAction ?? null
      notification.on('click', () => {
        this.clickHandler?.()
      })
      notification.show()
    } catch (err) {
      getLogger().debug('Notification failed', err)
    }
  }

  showUpdateAvailable(version: string, url: string): void {
    this.show({
      title: APP_NAME,
      body: `Version ${version} is available. Click to view release notes.`,
      clickAction: () => {
        void shell.openExternal(url)
      }
    })
  }
}