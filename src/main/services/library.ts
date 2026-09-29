import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Database } from './database'
import { getLogger } from './logger'
import { LibraryScanner } from './scanner'
import { FolderWatcher } from './watcher'
import { LibraryQueries } from './libraryQueries'
import { randomId } from '../util/hash'
import type { ArtworkService } from './artwork'
import type { TranscodeService } from './transcode'
import type { LibraryFolder, ScanProgress } from '@shared/types'

export type { SongsQuery } from './libraryQueries'

export class LibraryService extends LibraryQueries {
  scanner: LibraryScanner
  watcher = new FolderWatcher()
  private activeScan: Promise<unknown> | null = null

  constructor(
    db: Database,
    private artwork: ArtworkService,
    transcode: TranscodeService
  ) {
    super(db)
    this.scanner = new LibraryScanner(db, artwork, transcode)
    this.scanner.on('progress', (p: ScanProgress) => {
      this._lastProgress = p
      this.emit('scan-progress', p)
    })
    this.watcher.on('changed', ({ root, file }) => {
      void this.handleWatchEvent(root, file)
    })
    this.watcher.on('sweep', ({ root }) => {
      void this.handleWatchEvent(root, null)
    })
  }

  // ------------------------------------------------------------------
  // Folders
  // ------------------------------------------------------------------

  async addFolder(dir: string): Promise<LibraryFolder | null> {
    const resolved = path.resolve(dir)
    let stat: fs.Stats
    try {
      stat = fs.statSync(resolved)
      if (!stat.isDirectory()) throw new Error('Not a directory')
    } catch (err) {
      getLogger().warn(`addFolder invalid: ${resolved}`, err)
      return null
    }
    const existing = this.db.get<{ id: string }>(
      'SELECT id FROM library_locations WHERE path = ?',
      [resolved]
    )
    if (existing) {
      return this.getFolder(existing.id)
    }
    const id = randomId()
    this.db.run(
      'INSERT INTO library_locations (id, path, name, added_at) VALUES (?, ?, ?, ?)',
      [id, resolved, path.basename(resolved), Date.now()]
    )
    this.emit('library-changed')
    void this.scanLibrary(id)
    return this.getFolder(id)
  }

  /**
   * Removing a library location deletes ONLY songs that belong to it.
   * Playlists keep their entries; the UI renders them as missing tracks.
   */
  removeFolder(id: string): void {
    this.watcher.stopWatching(
      this.db.get<{ path: string }>('SELECT path FROM library_locations WHERE id = ?', [id])
        ?.path ?? ''
    )
    this.db.run('DELETE FROM library_locations WHERE id = ?', [id])
    this.db.run('DELETE FROM songs WHERE library_id = ?', [id])
    this.rebuildAggregates()
    this.emit('library-changed')
  }

  // ------------------------------------------------------------------
  // Scanning
  // ------------------------------------------------------------------

  /** Scan requested while another one ran ('*' = full library). */
  private pendingScans = new Set<string>()
  private pendingForce = false

  async scanLibrary(libraryId?: string, force = false): Promise<void> {
    if (this.activeScan) {
      // Don't drop the request: adding two folders at once used to scan only
      // the first one (the second call just returned the running scan).
      this.pendingScans.add(libraryId ?? '*')
      this.pendingForce ||= force
      await this.activeScan.catch(() => undefined)
      return this.runPendingScans()
    }
    const promise = (async () => {
      const counters = await this.scanner.scanLibrary({ libraryId, force })
      getLogger().info('Scan finished', counters)
      this.rebuildAggregates()
      if (libraryId) {
        this.db.run('UPDATE library_locations SET last_scan_at = ? WHERE id = ?', [
          Date.now(),
          libraryId
        ])
      }
      if (this.watcher.disabled) this.startWatchers()
      this.emit('scan-complete', counters)
      this.emit('library-changed')
    })()
    this.activeScan = promise
    try {
      await promise
    } finally {
      this.activeScan = null
    }
    await this.runPendingScans()
  }

  private async runPendingScans(): Promise<void> {
    if (this.activeScan || this.pendingScans.size === 0) return
    const ids = [...this.pendingScans]
    const force = this.pendingForce
    this.pendingScans.clear()
    this.pendingForce = false
    if (ids.includes('*')) {
      await this.scanLibrary(undefined, force)
      return
    }
    for (const id of ids) await this.scanLibrary(id, force)
  }

  cancelScan(): void {
    this.pendingScans.clear()
    this.scanner.cancel()
  }

  get lastProgress(): ScanProgress | null {
    return this._lastProgress
  }

  private _lastProgress: ScanProgress | null = null

  /** When the last watch-event-triggered scan ran (rate-limits A:\ noise). */
  private lastWatchScanAt = 0

  startWatchers(): void {
    for (const folder of this.getFolders()) {
      if (fs.existsSync(folder.path)) this.watcher.watchRoot(folder.path)
    }
  }

  stopWatchers(): void {
    this.watcher.clear()
  }

  private async handleWatchEvent(root: string, _file: string | null): Promise<void> {
    try {
      const lib = this.db.get<{ id: string }>(
        'SELECT id FROM library_locations WHERE path = ?',
        [path.resolve(root)]
      )
      if (!lib) return
      if (this.activeScan) return // full scan will reconcile everything
      // Rate-limit: watch events (e.g. from the drive's own metadata traffic)
      // must not trigger a full rescan every few seconds.
      if (Date.now() - this.lastWatchScanAt < 30_000) return
      this.lastWatchScanAt = Date.now()
      await this.scanLibrary(lib.id, false)
    } catch (err) {
      getLogger().warn('Watch event scan failed', err)
    }
  }

  get artworkArtworkDir(): string {
    return this.artwork.cacheDir
  }
}
