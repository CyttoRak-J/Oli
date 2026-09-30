import { BrowserWindow, Menu, nativeImage, screen, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { getLogger } from './services/logger'
import { isQuitting } from './appState'
import { IPC } from '@shared/ipc'
import type { SettingsStore } from './services/settingsStore'
import type { ProviderService } from './services/provider'
import { buildVideoPage, type VideoQualitySet } from '@shared/videoPage'

const MAIN_W = 1280
const MAIN_H = 800
const MINI_W = 320
const MINI_H = 440
const BUBBLE_SIZE = 48

const THEME_BACKGROUND: Record<string, string> = {
  dark: '#0b0b12',
  amoled: '#000000',
  light: '#f4f4f8'
}

interface BoundsPersistence {
  load: () => { x?: number; y?: number; width?: number; height?: number; maximized?: boolean } | null
  save: (bounds: { x: number; y: number; width: number; height: number; maximized: boolean }) => void
}

interface SnapResult {
  x: number
  y: number
  /** Distance from the original center to the snapped edge position. */
  distance: number
}

/** Nearest edge-dock position (half in / half out) for a bubble-sized window. */
function snapPosition(
  pos: { x: number; y: number },
  size: { width: number; height: number },
  display: Electron.Display
): SnapResult {
  const { bounds: db, workArea } = display
  const half = Math.round(size.width / 2)
  const yClamp = (y: number): number =>
    Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - size.height)
  const xClamp = (x: number): number =>
    Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - size.width)
  const candidates = [
    { x: db.x - half, y: yClamp(pos.y) },
    { x: db.x + db.width - half, y: yClamp(pos.y) },
    { x: xClamp(pos.x), y: db.y - half },
    { x: xClamp(pos.x), y: db.y + db.height - half }
  ]
  const cx = pos.x + size.width / 2
  const cy = pos.y + size.height / 2
  let target = candidates[0]
  let best = Infinity
  for (const c of candidates) {
    const d = Math.hypot(c.x + size.width / 2 - cx, c.y + size.height / 2 - cy)
    if (d < best) {
      best = d
      target = c
    }
  }
  return { x: target.x, y: target.y, distance: best }
}

export class WindowManager {
  mainWindow: BrowserWindow | null = null
  miniWindow: BrowserWindow | null = null
  bubbleWindow: BrowserWindow | null = null
  videoWindow: BrowserWindow | null = null

  /** Whether the tray icon is showing (set by the app once the tray exists). */
  private trayActive: () => boolean = () => false

  setTrayActiveCheck(fn: () => boolean): void {
    this.trayActive = fn
  }

  constructor(
    private boundsStore: BoundsPersistence,
    private settings: SettingsStore,
    private providers: ProviderService
  ) {}

  private themeBackground(): string {
    const theme = this.settings.get('themeMode') ?? 'dark'
    return THEME_BACKGROUND[theme] ?? THEME_BACKGROUND['dark']
  }

  /** Re-apply the theme background color to all live windows. */
  applyWindowTheme(): void {
    const bg = this.themeBackground()
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !(win === this.bubbleWindow)) {
        win.setBackgroundColor(bg)
      }
    }
  }

  private async rendererUrl(): Promise<string> {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl) return devUrl
    return path.join(__dirname, '../renderer/index.html')
  }

  /**
   * ADDED: Electron does not provide a native OS right-click context menu on
   * web content — you have to build one. Without this, right-clicking any
   * text input (the search bar, playlist name fields, settings fields, etc.)
   * or any selected text anywhere in the app does nothing at all. Wired once
   * per window (called from loadInto so every window — main, mini, bubble,
   * video — gets it) rather than per-component, so it works everywhere
   * automatically, not just on the search bar.
   */
  private attachContextMenu(win: BrowserWindow): void {
    win.webContents.on('context-menu', (_event, params) => {
      const items: MenuItemConstructorOptions[] = []

      if (params.isEditable) {
        items.push(
          { role: 'undo', enabled: params.editFlags.canUndo },
          { role: 'redo', enabled: params.editFlags.canRedo },
          { type: 'separator' },
          { role: 'cut', enabled: params.editFlags.canCut },
          { role: 'copy', enabled: params.editFlags.canCopy },
          { role: 'paste', enabled: params.editFlags.canPaste },
          { type: 'separator' },
          { role: 'selectAll', enabled: params.editFlags.canSelectAll }
        )
      } else if (params.selectionText) {
        items.push({ role: 'copy' })
      }

      if (params.misspelledWord) {
        const suggestions = params.dictionarySuggestions.slice(0, 5).map((s) => ({
          label: s,
          click: () => win.webContents.replaceMisspelling(s)
        }))
        items.unshift(
          ...(suggestions.length ? suggestions : [{ label: 'No suggestions', enabled: false }]),
          { type: 'separator' as const }
        )
      }

      if (items.length === 0) return
      Menu.buildFromTemplate(items).popup({ window: win })
    })
  }

  private async loadInto(win: BrowserWindow, hash = ''): Promise<void> {
    this.attachContextMenu(win)
    const target = await this.rendererUrl()
    if (target.startsWith('http')) {
      const url = `${target}#${hash}`
      for (let attempt = 1; ; attempt++) {
        try {
          await win.loadURL(url)
          return
        } catch (err) {
          if (attempt >= 6) throw err
          getLogger().warn(`Renderer load attempt ${attempt} failed (dev cold start?), retrying`, err)
          await new Promise((r) => setTimeout(r, 1200 * attempt))
        }
      }
    } else {
      await win.loadFile(target, { hash })
    }
  }

  createMainWindow(): BrowserWindow {
    const saved = this.boundsStore.load()
    const win = new BrowserWindow({
      width: saved?.width ?? MAIN_W,
      height: saved?.height ?? MAIN_H,
      x: saved?.x,
      y: saved?.y,
      minWidth: 940,
      minHeight: 600,
      show: false,
      frame: false,
      title: 'Oli',
      backgroundColor: this.themeBackground(),
      icon: path.join(__dirname, '../../build/icon.png'),
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false
      }
    })
    this.mainWindow = win

    win.on('ready-to-show', () => {
      if (saved?.maximized) win.maximize()
      win.show()
    })
    win.on('close', (event) => {
      // Keep the player (and its audio) alive in the background when the
      // mini player / bubble is in use, or when "close to tray" is enabled.
      const keepAlive =
        !isQuitting() &&
        (process.env['CYTTO_CLOSE_TO_TRAY'] === '1' ||
          (this.miniWindow && !this.miniWindow.isDestroyed()) ||
          (this.bubbleWindow && !this.bubbleWindow.isDestroyed()))
      if (keepAlive) {
        event.preventDefault()
        win.hide()
      } else {
        this.persistBounds(win)
      }
    })
    win.on('closed', () => {
      this.mainWindow = null
    })
    // "Minimize to tray" (Preferences): only when the tray icon exists to
    // bring the window back.
    win.on('minimize', () => {
      if (this.settings.getBoolean('minimizeToTray') && this.trayActive()) win.hide()
    })
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (event, url) => {
      const isLocal =
        url.startsWith('file:') ||
        url.startsWith('http://localhost') ||
        url.startsWith('http://127.0.0.1') ||
        url.startsWith('cyttos-art:') ||
        url.startsWith('cyttos-local:')
      if (!isLocal) {
        event.preventDefault()
        if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      }
    })
    void this.loadInto(win)
    return win
  }

  createMiniWindow(origin?: { x: number; y: number }): BrowserWindow {
    if (this.miniWindow && !this.miniWindow.isDestroyed()) {
      this.miniWindow.show()
      this.miniWindow.focus()
      return this.miniWindow
    }
    // Only one floating widget at a time: opening the mini player closes the bubble.
    this.closeBubble()
    let x: number | undefined
    let y: number | undefined
    if (origin) {
      const display = screen.getDisplayMatching({
        x: origin.x,
        y: origin.y,
        width: 1,
        height: 1
      })
      const { workArea } = display
      x = Math.min(Math.max(origin.x, workArea.x), workArea.x + workArea.width - MINI_W)
      y = Math.min(Math.max(origin.y, workArea.y), workArea.y + workArea.height - MINI_H)
    }
    const win = new BrowserWindow({
      width: MINI_W,
      height: MINI_H,
      minWidth: 280,
      minHeight: 340,
      show: false,
      frame: false,
      x,
      y,
      alwaysOnTop: this.settings.getBoolean('miniPlayerAlwaysOnTop'),
      resizable: true,
      skipTaskbar: !this.settings.getBoolean('miniPlayerTaskbar'),
      title: 'Oli Mini',
      backgroundColor: this.themeBackground(),
      icon: path.join(__dirname, '../../build/icon.png'),
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false
      }
    })
    this.miniWindow = win
    win.on('ready-to-show', () => win.show())
    win.on('closed', () => {
      this.miniWindow = null
      this.restoreMainIfOrphaned()
    })
    // Clicking anywhere else collapses the mini player back into a bubble.
    // The mini does not regain focus on every window it steals it from, but
    // it must have been focused at least once before a blur may collapse it,
    // and deliberate switches (toBubble / toMini) or a real close must not.
    let everFocused = false
    let closing = false
    win.on('focus', () => {
      everFocused = true
    })
    win.on('close', () => {
      closing = true
    })
    win.on('blur', () => {
      if (!everFocused || closing || win.isDestroyed()) return
      if (this.miniWindow !== win) return
      if (Date.now() - this.floatingSwitchAt < 400) return
      this.toBubble()
    })
    void this.loadInto(win, '/mini')
    return win
  }

  /**
   * The main window hides (instead of closing) while a mini player / bubble
   * is open. When the last floating widget then closes, bring the main
   * window back: otherwise the app keeps playing with no visible window
   * (unless "close to tray" deliberately keeps it in the tray).
   */
  private restoreMainIfOrphaned(): void {
    // Deferred: toBubble()/toMini() close one widget and open the other.
    setTimeout(() => {
      if (isQuitting()) return
      if (this.miniWindow && !this.miniWindow.isDestroyed()) return
      if (this.bubbleWindow && !this.bubbleWindow.isDestroyed()) return
      if (process.env['CYTTO_CLOSE_TO_TRAY'] === '1') return
      const main = this.mainWindow
      if (main && !main.isDestroyed() && !main.isVisible()) main.show()
    }, 150)
  }

  /** Apply always-on-top / taskbar settings to an existing mini window. */
  applyMiniSettings(): void {
    if (this.miniWindow && !this.miniWindow.isDestroyed()) {
      this.miniWindow.setSkipTaskbar(!this.settings.getBoolean('miniPlayerTaskbar'))
      this.miniWindow.setAlwaysOnTop(this.settings.getBoolean('miniPlayerAlwaysOnTop'), 'screen-saver')
    }
    if (this.bubbleWindow && !this.bubbleWindow.isDestroyed()) {
      this.bubbleWindow.setAlwaysOnTop(this.settings.getBoolean('miniPlayerAlwaysOnTop'), 'screen-saver')
    }
  }

  private defaultBubblePosition(): { x: number; y: number } {
    const { workArea } = screen.getPrimaryDisplay()
    return {
      x: workArea.x + workArea.width - Math.round(BUBBLE_SIZE / 2),
      y: Math.round(workArea.y + (workArea.height - BUBBLE_SIZE) / 2)
    }
  }

  /** Persist the bubble position (throttled). */
  private lastBubbleSave = 0

  persistBubblePosition(): void {
    const win = this.bubbleWindow
    if (!win || win.isDestroyed()) return
    const now = Date.now()
    if (now - this.lastBubbleSave < 500) return
    this.lastBubbleSave = now
    const b = win.getBounds()
    this.settings.set('bubblePosition', { x: b.x, y: b.y })
  }

  private bubbleSnapTimer: NodeJS.Timeout | null = null

  /** Guards blur-triggered collapse while a widget switch is in flight. */
  private floatingSwitchAt = 0

  /** Stop any running snap animation (e.g. user grabbed the bubble mid-snap). */
  cancelBubbleSnap(): void {
    if (this.bubbleSnapTimer) {
      clearInterval(this.bubbleSnapTimer)
      this.bubbleSnapTimer = null
    }
  }

  /** Animate the bubble from its current position to (tx, ty) with ease-out. */
  private animateTo(win: BrowserWindow, tx: number, ty: number, duration: number): void {
    const [sx, sy] = win.getPosition()
    if (sx === tx && sy === ty) return
    this.cancelBubbleSnap()
    const start = Date.now()
    this.bubbleSnapTimer = setInterval(() => {
      if (win.isDestroyed()) {
        this.cancelBubbleSnap()
        return
      }
      const t = Math.min(1, (Date.now() - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      win.setPosition(Math.round(sx + (tx - sx) * eased), Math.round(sy + (ty - sy) * eased))
      if (t >= 1) {
        this.cancelBubbleSnap()
        this.lastBubbleSave = 0
        this.persistBubblePosition()
      }
    }, 16)
  }

  /**
   * Magnetically snap the bubble to the nearest screen edge, docked half
   * inside / half outside, keeping its position along that edge. Only snaps
   * when the bubble is released close enough to an edge.
   */
  snapBubble(): void {
    const win = this.bubbleWindow
    if (!win || win.isDestroyed()) return
    const bounds = win.getBounds()
    const snap = snapPosition(
      { x: bounds.x, y: bounds.y },
      { width: bounds.width, height: bounds.height },
      screen.getDisplayMatching(bounds)
    )
    if (snap.distance > 260) return
    this.animateTo(win, snap.x, snap.y, 260)
  }

  /** Slide a docked (half-hidden) bubble fully back onto the screen. */
  bubbleReveal(): void {
    const win = this.bubbleWindow
    if (!win || win.isDestroyed()) return
    const bounds = win.getBounds()
    const { workArea } = screen.getDisplayMatching(bounds)
    const tx = Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - bounds.width)
    const ty = Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - bounds.height)
    this.animateTo(win, tx, ty, 140)
  }

  createBubbleWindow(): BrowserWindow {
    if (this.bubbleWindow && !this.bubbleWindow.isDestroyed()) {
      this.bubbleWindow.show()
      this.bubbleWindow.focus()
      return this.bubbleWindow
    }
    // Only one floating widget at a time: opening the bubble closes the mini player.
    this.closeMiniWindow()
    const saved = this.settings.get('bubblePosition')
    const savedPos = saved && typeof saved.x === 'number' && typeof saved.y === 'number' ? saved : null
    let pos = savedPos ?? this.defaultBubblePosition()
    const display = screen.getDisplayMatching({ x: pos.x, y: pos.y, width: 1, height: 1 })
    // Docked bubble positions are stored half off-screen; keep those as-is,
    // but pull any fully on-screen position back to the nearest edge so the
    // bubble always shows as a half-peek (never a full disk).
    const snap = snapPosition(pos, { width: BUBBLE_SIZE, height: BUBBLE_SIZE }, display)
    pos = { x: snap.x, y: snap.y }
    const win = new BrowserWindow({
      width: BUBBLE_SIZE,
      height: BUBBLE_SIZE,
      x: pos.x,
      y: pos.y,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      hasShadow: false,
      alwaysOnTop: this.settings.getBoolean('miniPlayerAlwaysOnTop'),
      skipTaskbar: true,
      title: 'Oli Bubble',
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false
      }
    })
    this.bubbleWindow = win
    win.on('ready-to-show', () => win.show())
    win.on('move', () => this.persistBubblePosition())
    win.on('close', () => {
      this.lastBubbleSave = 0
      this.persistBubblePosition()
    })
    win.on('closed', () => {
      this.bubbleWindow = null
      this.restoreMainIfOrphaned()
    })
    void this.loadInto(win, '/bubble')
    return win
  }

  closeBubble(): void {
    if (this.bubbleWindow && !this.bubbleWindow.isDestroyed()) {
      this.bubbleWindow.close()
    }
  }

  closeMiniWindow(): void {
    if (this.miniWindow && !this.miniWindow.isDestroyed()) {
      this.miniWindow.close()
    }
  }

  /**
   * Open (or re-point) an internal media-player window that plays a YouTube
   * video with both audio and video. The stream URLs are resolved with yt-dlp
   * and played in a bare <video> element, so only the video itself is shown
   * (no YouTube chrome, sidebar, comments or embed restrictions). A quality
   * selector is offered when multiple stream heights are available. If no
* stream can be resolved, a minimal embed player is used instead — never
   * the full YouTube website.
   */
  async openVideoWindow(videoId: string): Promise<void> {
    if (!videoId) return
    const win = this.videoWindow && !this.videoWindow.isDestroyed() ? this.videoWindow : null
    if (win) {
      win.show()
      win.focus()
    } else {
      const created = new BrowserWindow({
        width: 960,
        height: 540,
        minWidth: 480,
        minHeight: 270,
        show: false,
        title: 'Oli Video',
        backgroundColor: '#000000',
        icon: path.join(__dirname, '../../build/icon.png'),
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          spellcheck: false,
          preload: path.join(__dirname, '../preload/index.js')
        }
      })
      created.webContents.setWindowOpenHandler(({ url: target }) => {
        void shell.openExternal(target)
        return { action: 'deny' }
      })
      // The page raises hashes for events: video ended or muted -> resume the
      // song; video unmuted/user play -> pause the song (one audio at a time).
      created.webContents.on('did-navigate-in-page', (_e, url) => {
        if (url.includes('#cyttos-video-ended') || url.includes('#cyttos-video-muted')) {
          this.resumeSongIfPaused()
        } else if (url.includes('#cyttos-video-unmuted') || url.includes('#cyttos-video-play')) {
          this.pauseSongForVideo()
        }
      })
      // Native playback-start signal: covers play/quality switches/repeat.
      created.webContents.on('media-started-playing', () => this.pauseSongForVideo())
      // Bulletproof hls.js: if the bundled <script> tag ever fails to load,
      // inject the library straight from the main process.
      created.webContents.on('did-finish-load', () => {
        try {
          const hlsSrc = fs.readFileSync(require.resolve('hls.js/dist/hls.min.js'), 'utf8')
          created.webContents
            .executeJavaScript(`(function(){ if (typeof self.Hls === 'undefined') { ${hlsSrc} } })()`)
            .catch(() => {})
        } catch {
          // ignore
        }
      })
      created.on('ready-to-show', () => created.show())
      created.on('closed', () => {
        this.videoWindow = null
      })
      this.videoWindow = created
    }

    const target = this.videoWindow
    if (!target) return
    const set = await this.providers.resolveYouTubeVideoQualities(videoId)
    if (target.isDestroyed()) return
    if (set.fresh && set.streams.length > 0) {
      // A freshly resolved set is followed by a short server-side 403 window:
      // googlevideo transiently rejects the brand-new URLs (anti-bot burst
      // protection right after yt-dlp's resolve burst), which Chromium's ORB
      // turns into a media FormatError. Cached sets are never affected, so
      // only delay the first load and let the window clear.
      await new Promise((resolve) => setTimeout(resolve, 2500))
    }
    if (target.isDestroyed()) return
    if (set.streams.length > 0) {
      void target.loadURL(this.videoPageHtml(set, videoId))
      return
    }
    const streamUrl = await this.providers.resolveYouTubeVideo(videoId)
    if (target.isDestroyed()) return
    if (streamUrl) {
      void target.loadURL(
        this.videoPageHtml(
          { streams: [{ height: 0, url: streamUrl, hls: false, videoOnly: false }], audioUrl: null },
          videoId
        )
      )
      return
    }
    // No resolvable stream: show the in-app error page with Retry / backup
    // stream. Never fall back to YouTube's embed player (ads, restrictions,
    // confusing native errors like "Error 153").
    void target.loadURL(this.videoPageHtml({ streams: [], audioUrl: null }, videoId))
    return
  }

  /** Pause the internal video player when the main app starts a song (not while muted). */
  pauseVideo(): void {
    const w = this.videoWindow
    if (!w || w.isDestroyed()) return
    w.webContents
      .executeJavaScript(
        `(() => { const v = document.querySelector('video'); if (!v || v.muted) return; v.pause() })()`
      )
      .catch(() => {})
  }

  /** True while the video player is "ended" because of a finished playback. */
  private resumeSongPausedByVideo = false

  /** Set when opening the video pauses the app's song, so it can be resumed at the end. */
  noteSongPausedByVideo(): void {
    this.resumeSongPausedByVideo = true
  }

  /** The user pressed play in the video window: pause the app's song (not when the video is muted). */
  pauseSongForVideo(): void {
    const w = this.videoWindow
    if (!w || w.isDestroyed()) return
    w.webContents
      .executeJavaScript(`(() => { const v = document.querySelector('video'); return !v || v.muted })()`)
      .then((mutedOrNoVideo) => {
        if (mutedOrNoVideo) return
        this.noteSongPausedByVideo()
        this.sendToMain(IPC.onPlaybackCommand, 'pause')
      })
      .catch(() => {})
  }

  /** Resume the app's song if the video window ever paused it. */
  resumeSongIfPaused(): void {
    if (!this.resumeSongPausedByVideo) return
    this.resumeSongPausedByVideo = false
    const win = this.mainWindow
    if (!win || win.isDestroyed()) return
    win.webContents.send(IPC.onPlaybackCommand, 'resume')
  }

  private videoPageHtml(set: VideoQualitySet, videoId: string): string {
    const html = buildVideoPage(set, videoId, '<script src="cyttos-vendor://hls/hls.min.js"></script>')
    return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
  }

  /** Bring the main window up and close any floating widget (mini / bubble). */
  showMain(): BrowserWindow {
    let win = this.getMain()
    if (!win || win.isDestroyed()) {
      win = this.createMainWindow()
    } else {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
    this.closeMiniWindow()
    this.closeBubble()
    return win
  }

  /** Switch the floating widget to bubble mode (from mini). */
  toBubble(): void {
    this.floatingSwitchAt = Date.now()
    if (this.miniWindow && !this.miniWindow.isDestroyed()) {
      this.miniWindow.close()
    }
    this.createBubbleWindow()
  }

  /** Switch the floating widget to mini-player mode (from bubble). */
  toMini(): void {
    this.floatingSwitchAt = Date.now()
    const bubbleBounds =
      this.bubbleWindow && !this.bubbleWindow.isDestroyed() ? this.bubbleWindow.getBounds() : null
    this.closeBubble()
    this.createMiniWindow(bubbleBounds ? { x: bubbleBounds.x, y: bubbleBounds.y } : undefined)
  }

  /** Close the mini player (and bubble) and bring the main window back. */
  expandMini(): void {
    this.showMain()
  }

  private persistBounds(win: BrowserWindow): void {
    if (win.isMinimized() || win.isFullScreen()) return
    try {
      this.boundsStore.save({
        ...win.getBounds(),
        maximized: win.isMaximized()
      })
    } catch (err) {
      getLogger().debug('Bounds save failed', err)
    }
  }

  broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload)
      }
    }
  }

  sendToMain(channel: string, payload: unknown): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, payload)
    }
  }

  getMain(): BrowserWindow | null {
    return this.mainWindow
  }

  setTaskbarProgress(value: number, enabled: boolean): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return
    if (!enabled || value <= 0) {
      this.mainWindow.setProgressBar(-1)
      return
    }
    this.mainWindow.setProgressBar(Math.min(1, Math.max(0, value)))
  }

  setThumbarButtons(handlers: { onPlayPause: () => void; onPrev: () => void; onNext: () => void }): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return
    const base = path.join(__dirname, '../../build')
    const icons = {
      prev: nativeImage.createFromPath(path.join(base, 'tray-prev.png')),
      playPause: nativeImage.createFromPath(path.join(base, 'tray-pause.png')),
      next: nativeImage.createFromPath(path.join(base, 'tray-next.png'))
    }
    if (icons.prev.isEmpty() || icons.playPause.isEmpty() || icons.next.isEmpty()) return
    this.mainWindow.setThumbarButtons([
      { tooltip: 'Previous', icon: icons.prev, click: handlers.onPrev },
      { tooltip: 'Play / Pause', icon: icons.playPause, click: handlers.onPlayPause },
      { tooltip: 'Next', icon: icons.next, click: handlers.onNext }
    ])
  }
}
