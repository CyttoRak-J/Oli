import { BrowserWindow, nativeImage, screen, shell } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { getLogger } from './services/logger'
import { isQuitting } from './appState'
import { IPC } from '@shared/ipc'
import type { SettingsStore } from './services/settingsStore'
import type { ProviderService, VideoQualitySet } from './services/provider'

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

  private async loadInto(win: BrowserWindow, hash = ''): Promise<void> {
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
        sandbox: false,
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
    win.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url)
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
        void shell.openExternal(url)
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
        sandbox: false,
        spellcheck: false
      }
    })
    this.miniWindow = win
    win.on('ready-to-show', () => win.show())
    win.on('closed', () => {
      this.miniWindow = null
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
    void this.loadInto(win, 'mini')
    return win
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
        sandbox: false,
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
    })
    void this.loadInto(win, 'bubble')
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
          sandbox: false,
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

  /** Builds a self-contained page with a bare <video>, quality selector and repeat.
   * Video-only DASH streams are paired with the best audio stream in a hidden
   * <audio> element so 1080p+ videos actually have sound. A download panel
   * starts a merged video+audio download (shown in the app's Downloads list). */
  private videoPageHtml(set: VideoQualitySet, videoId: string): string {
    const labeled = set.streams.map((s) => ({
      url: s.url,
      hls: s.hls,
      audio: s.videoOnly ? set.audioUrl : null,
      label: s.height > 0 ? `${s.height}p` : 'Best',
      height: s.height
    }))
    const json = JSON.stringify(labeled).replace(/</g, '\\u003c')
    const html =
      `<!doctype html><html><head><meta charset="utf-8">` +
      `<script src="cyttos-vendor://hls/hls.min.js"></script>` +
      `<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}` +
      `video{width:100vw;height:100vh;display:block;object-fit:contain;background:#000}` +
      `#qbar{position:fixed;top:10px;right:10px;z-index:10;display:flex;align-items:center;gap:6px;background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.25);border-radius:8px;padding:4px 6px;font:12px system-ui;color:#fff}` +
      `#qbar select{background:rgba(0,0,0,.7);color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:6px;padding:2px 4px;font-size:12px;outline:none}` +
      `#curq{min-width:34px;text-align:center;font-variant-numeric:tabular-nums;color:#ffd54a;font-weight:600}` +
      `#repeat{background:transparent;border:1px solid rgba(255,255,255,.3);border-radius:6px;color:#fff;padding:2px 8px;font-size:12px;cursor:pointer}` +
      `#repeat.active{background:rgba(255,255,255,.28);border-color:#fff}` +
      `#dlbtn{cursor:pointer;background:transparent;border:1px solid rgba(255,255,255,.3);border-radius:6px;color:#fff;padding:2px 9px;font-size:13px;line-height:1.3}` +
      `#dlbtn:hover{background:rgba(255,255,255,.18)}` +
      `#vol{width:80px;accent-color:#ffd54a;cursor:pointer}` +
      `#dlp{display:none;position:fixed;inset:0;z-index:20;align-items:center;justify-content:center;background:rgba(0,0,0,.55)}` +
      `#dlbox{width:min(400px,90vw);background:#181818;border:1px solid rgba(255,255,255,.22);border-radius:12px;padding:16px;font:13px system-ui;color:#eee;display:flex;flex-direction:column;gap:10px}` +
      `#dlbox h3{margin:0 0 2px;font-size:14px;color:#fff}` +
      `#dlbox label{display:flex;justify-content:space-between;align-items:center;gap:10px;color:#bbb}` +
      `#dlbox select,#dlbox input{background:#111;color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:6px;padding:4px 6px;font-size:12px;outline:none;min-width:0}` +
      `#dlf{flex:1}` +
      `#dlbox .row{display:flex;gap:6px}` +
      `#dlbox button{background:#ffd54a;color:#111;font-weight:700;border:0;border-radius:8px;padding:8px 10px;cursor:pointer;font-size:13px}` +
      `#dlbox button.sec{background:transparent;color:#ccc;border:1px solid rgba(255,255,255,.35);padding:4px 8px;font-weight:500}` +
      `#dlstatus{font-size:12px;color:#ffd54a;min-height:16px}` +
      `#errbox{display:none;position:fixed;inset:0;z-index:30;align-items:center;justify-content:center;background:rgba(0,0,0,.65);color:#fff;font:14px system-ui}` +
      `#errbox .eb2{background:#181818;border:1px solid rgba(255,255,255,.25);border-radius:12px;padding:18px;display:flex;flex-direction:column;gap:10px;text-align:center;min-width:260px}` +
      `#errbox button{background:#ffd54a;color:#111;font-weight:700;border:0;border-radius:8px;padding:8px 12px;cursor:pointer;font-size:13px}` +
      `#errbox button.sec{background:transparent;color:#ccc;border:1px solid rgba(255,255,255,.35);font-weight:500}` +
      `</style></head><body>` +
      `<video id="v" controls playsinline autoplay></video>` +
      `<audio id="a" style="display:none" preload="auto"></audio>` +
      `<div id="qbar"><span id="curq">-</span> Quality <select id="q"></select><input id="vol" type="range" min="0" max="100" value="100" title="Volume"><select id="spd" title="Playback speed"></select><button id="dlbtn" title="Download video">⤓</button><button id="repeat" title="Repeat video">Repeat</button></div>` +
      `<div id="dlp"><div id="dlbox"><h3>Download video</h3>` +
      `<label>Video quality<select id="dlv"></select></label>` +
      `<label>Audio<select id="dla"><option value="best">Best audio</option><option value="m4a">MP4 (AAC)</option><option value="opus">Opus (WebM)</option></select></label>` +
      `<label>Folder<div class="row"><input id="dlf" placeholder="Default downloads folder"><button class="sec" id="dlpick">Choose…</button></div></label>` +
      `<div class="row"><button id="dlstart">Download video</button><span id="dlstatus"></span></div>` +
      `<div class="row"><button id="dlsong">Download song (tagged)</button><span id="dlsstatus" style="color:#8fe388"></span></div>` +
      `<div id="dlsng" style="font-size:11.5px;color:#bbb">Best audio only, with cover art + title/artist/album tags embedded.</div>` +
      `</div></div>` +
      `<div id="errbox"><div class="eb2"><div>Video playback failed</div><div id="errmsg" style="font-size:12px;color:#bbb">The stream could not be played.</div><div style="display:flex;gap:8px;justify-content:center"><button id="errretry">Retry</button><button id="errfallback" class="sec">Try backup stream</button></div></div></div>` +
      `<script>` +
      `const VID=${JSON.stringify(videoId)};` +
      `const ST=${json};const v=document.getElementById('v');const a=document.getElementById('a');const sel=document.getElementById('q');const curq=document.getElementById('curq');` +
      `const vol=document.getElementById('vol');const spd=document.getElementById('spd');` +
      `const dlbtn=document.getElementById('dlbtn');const dlp=document.getElementById('dlp');const dlv=document.getElementById('dlv');const dla=document.getElementById('dla');const dlf=document.getElementById('dlf');const dlstart=document.getElementById('dlstart');const dlstatus=document.getElementById('dlstatus');const dlsong=document.getElementById('dlsong');const dlsstatus=document.getElementById('dlsstatus');dlp.style.display='none';` +
      `const HLS=typeof self.Hls!=='undefined';let hls=null;` +
      `sel.style.display=ST.length>1?'':'none';` +
      `if(ST.length>1){ST.forEach((s,i)=>{const o=document.createElement('option');o.value=i;o.textContent=s.label;sel.appendChild(o)});}` +
      `[0.5,0.75,1,1.25,1.5,2].forEach(r=>{const o=document.createElement('option');o.value=String(r);o.textContent=r+'x';spd.appendChild(o)});spd.value='1';` +
      `let pos=0;let repeat=false;let switching=false;let firstPlay=true;let seq=0;` +
      `let autoRetried=false;let arTimer=null;` +
      `let stallIv=null;function clearStall(){if(stallIv){clearInterval(stallIv);stallIv=null}}` +
      `function armStall(){clearStall();const t0=Date.now();stallIv=setInterval(()=>{if(v.readyState>=3||(v.currentTime>0.2&&!v.paused)){clearStall();return}if(Date.now()-t0>8000){clearStall();stepDown()}},2000)}` +
      `function tearDown(){clearStall();if(hls){hls.destroy();hls=null}}` +
      `function whenHls(cb){if(typeof self.Hls!=='undefined'){cb()}else{let t=0;const iv=setInterval(()=>{t+=50;if(typeof self.Hls!=='undefined'||t>3000){clearInterval(iv);cb()}},50)}}` +
      `function setAudio(s){if(!s||!s.audio){a.removeAttribute('src');a.load();return}a.src=s.audio;a.load();a.volume=v.volume;a.muted=v.muted;a.playbackRate=v.playbackRate;if(!v.paused||v.autoplay)a.play().catch(()=>{})}` +
      `function setStream(i){const s=ST[i];if(!s)return;switching=true;setTimeout(()=>{switching=false},700);pos=v.currentTime||0;tearDown();curq.textContent=s.label;setAudio(s);` +
      `if(s.hls&&HLS&&!v.canPlayType('application/vnd.apple.mpegurl')){` +
      `let h=hls=new Hls({maxBufferLength:20});const buf=pos;h.loadSource(s.url);h.attachMedia(v);` +
      `h.on(Hls.Events.MANIFEST_PARSED,()=>{if(buf>0)v.currentTime=buf;v.play().catch(()=>{});armStall()});` +
      `h.on(Hls.Events.ERROR,(_e,d)=>{if(d&&d.fatal){tearDown();stepDown()}});` +
      `}else{` +
      `v.src=s.url;v.play().catch(()=>{});armStall();` +
      `}}` +
      `function stepDown(){const i=Number(sel.value);if(i<ST.length-1){sel.value=i+1;setStream(i+1)}else{showErr()}}` +
      `function showErr(){if(!autoRetried&&ST.length>0){autoRetried=true;arTimer=setTimeout(function(){if(v.readyState>=3||(v.currentTime>0.2&&!v.paused))return;setStream(0)},3000);return}document.getElementById('errbox').style.display='flex'}` +
      `function hideErr(){document.getElementById('errbox').style.display='none'}` +
      `dlbtn.addEventListener('click',()=>{const open=getComputedStyle(dlp).display!=='none';dlp.style.display=open?'none':'flex';if(dlv.options.length===0){const hs=[];ST.forEach(s=>{const h=Number(s.height);if(h>0&&hs.indexOf(h)<0)hs.push(h)});hs.sort((a,b)=>b-a);hs.forEach(h=>{const o=document.createElement('option');o.value=h;o.textContent=h+'p';dlv.appendChild(o)});const b=document.createElement('option');b.value='0';b.textContent='Best';dlv.insertBefore(b,dlv.firstChild);}});` +
      `dlp.addEventListener('click',(ev)=>{if(ev.target===dlp)dlp.style.display='none'});` +
      `document.getElementById('dlpick').addEventListener('click',async()=>{if(!window.cytto)return;const dir=await window.cytto.invoke('video:pick-folder');if(dir)dlf.value=dir;});` +
      `dlstart.addEventListener('click',async()=>{if(!window.cytto){dlstatus.textContent='Unavailable';return}const f=dlf.value.trim();const args=['video:download',VID,Number(dlv.value)||0,dla.value,f?f:null];dlstatus.textContent='Starting…';dlstart.disabled=true;try{const ok=await window.cytto.invoke.apply(null,args);dlstatus.textContent=ok?'Download started — see the Downloads page':"Couldn't start";}catch(e){dlstatus.textContent='Failed to start'}dlstart.disabled=false;setTimeout(()=>{dlstatus.textContent=''},5000)});` +
      `dlsong.addEventListener('click',async()=>{if(!window.cytto){dlsstatus.textContent='Unavailable';return}const f=dlf.value.trim();dlsstatus.textContent='Starting…';dlsong.disabled=true;try{const ok=await window.cytto.invoke.apply(null,['video:download-song',VID,dla.value,f?f:null]);dlsstatus.textContent=ok?'Song started — see the Downloads page':"Couldn't start";}catch(e){dlsstatus.textContent='Failed to start'}dlsong.disabled=false;setTimeout(()=>{dlsstatus.textContent=''},5000)});` +
      `vol.addEventListener('input',()=>{const x=Number(vol.value)/100;v.volume=x;if(a.src)a.volume=x;if(v.muted){v.muted=false}});` +
      `spd.addEventListener('change',()=>{const r=Number(spd.value);v.playbackRate=r;if(a.src)a.playbackRate=r});` +
      `v.addEventListener('loadedmetadata',()=>{if(pos>0){v.currentTime=pos}});` +
      `a.addEventListener('loadedmetadata',()=>{if(pos>0)a.currentTime=pos});` +
      `sel.addEventListener('change',()=>setStream(Number(sel.value)));` +
      `v.addEventListener('play',()=>{if(firstPlay){firstPlay=false;return}if(switching||v.muted)return;a.play().catch(()=>{});location.hash='#cyttos-video-play-'+(++seq)});` +
      `v.addEventListener('pause',()=>{if(!switching)a.pause()});` +
      `v.addEventListener('volumechange',()=>{vol.value=Math.round(v.volume*100);a.volume=v.volume;a.muted=v.muted;location.hash=(v.muted?'#cyttos-video-muted':'#cyttos-video-unmuted')+'-'+(++seq)});` +
      `v.addEventListener('ratechange',()=>{if(a.src)a.playbackRate=v.playbackRate});` +
      `v.addEventListener('seeked',()=>{if(a.src&&a.currentTime!==v.currentTime)a.currentTime=v.currentTime});` +
      `document.getElementById('repeat').addEventListener('click',()=>{repeat=!repeat;document.getElementById('repeat').classList.toggle('active',repeat);});` +
      `v.addEventListener('ended',()=>{a.pause();if(repeat){v.currentTime=0;v.play().catch(()=>{})}else{location.hash='#cyttos-video-ended-'+(++seq)}});` +
      `a.addEventListener('ended',()=>{if(!a.src)return;if(repeat){a.currentTime=0;a.play().catch(()=>{});if(v.ended||v.currentTime>=v.duration-0.3){v.currentTime=0;v.play().catch(()=>{})}}else{v.pause();if(!v.ended)location.hash='#cyttos-video-ended-'+(++seq)}});` +
      `v.addEventListener('error',stepDown);v.addEventListener('playing',function(){clearStall();if(arTimer){clearTimeout(arTimer);arTimer=null}});` +
      `if(ST.length>0){whenHls(function(){setStream(0)})}else{document.getElementById('errmsg').textContent='This video could not be loaded. Retry, or use the backup stream.';showErr()}` +
      `document.getElementById('errretry').addEventListener('click',()=>{hideErr();if(ST.length>0){setStream(0)}else if(window.cytto){window.cytto.invoke('video:retry',VID)}});` +
      `document.getElementById('errfallback').addEventListener('click',async()=>{if(!window.cytto)return;hideErr();let u=null;try{u=await window.cytto.invoke('video:fallback-url',VID)}catch(e){}if(!u){showErr();return}ST[ST.length]={url:u,hls:false,audio:null,label:'Best',height:0};sel.style.display=ST.length>1?'':'none';if(sel.value===''&&sel.options.length<ST.length-1){sel.options.length=0;ST.forEach((s,i)=>{const o=document.createElement('option');o.value=i;o.textContent=s.label;sel.appendChild(o)});sel.value=String(ST.length-1)}setStream(ST.length-1)});` +
      `</script></body></html>`
    return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
  }

  /** Bring the main window up and close any floating widget (mini / bubble). */
  showMain(): BrowserWindow {    let win = this.getMain()
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

  private persistBounds(win: BrowserWindow): void {    if (win.isMinimized() || win.isFullScreen()) return
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
