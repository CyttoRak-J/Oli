/**
 * Backup and restore of the phone library (the SQLite database). Automatic backups are files in the app's own folder
 * (newest 8 kept, like the PC); "export" hands a copy to Android's share sheet (save to Drive, send to the PC...);
 * "restore" takes a backup from that folder or a file the owner picks. A file is only accepted if it is a healthy Oli
 * library (checked before it replaces anything).
 */
export interface BackupStorage {
  list(): Promise<Array<{ name: string; createdAt: number; size: number }>>
  write(name: string, bytes: Uint8Array): Promise<void>
  read(name: string): Promise<Uint8Array>
  remove(name: string): Promise<void>
}

export interface BackupDatabase {
  exportBytes(): Uint8Array
  replaceFromBytes(bytes: Uint8Array): Promise<boolean>
}

const PREFIX = 'backup-'
const SUFFIX = '.sqlite'
export const KEEP_BACKUPS = 8

export class PhoneBackup {
  constructor(
    private db: BackupDatabase,
    private storage: BackupStorage,
    /** After a restore: bring an older schema up to date, reload settings, refresh the screens. */
    private afterRestore: () => void,
    private now: () => Date = () => new Date()
  ) {}

  /** Writes a new automatic backup; returns its name (null if there is nothing to save). */
  async create(): Promise<string | null> {
    const bytes = this.db.exportBytes()
    if (bytes.length === 0) return null
    const name = `${PREFIX}${this.now().toISOString().replace(/[:.]/g, '-')}${SUFFIX}`
    await this.storage.write(name, bytes)
    const all = await this.list()
    for (const old of all.slice(KEEP_BACKUPS)) await this.storage.remove(old.name).catch(() => undefined)
    return name
  }

  async list(): Promise<Array<{ name: string; path: string; createdAt: number; size: number }>> {
    const files = await this.storage.list()
    return files
      .filter((f) => f.name.startsWith(PREFIX) && f.name.endsWith(SUFFIX))
      .map((f) => ({ ...f, path: f.name }))
      .sort((a, b) => b.createdAt - a.createdAt || (a.name < b.name ? 1 : -1))
  }

  /** Replaces the library with the given bytes if they are a healthy Oli library. */
  async restoreBytes(bytes: Uint8Array): Promise<boolean> {
    if (bytes.length === 0) return false
    const ok = await this.db.replaceFromBytes(bytes)
    if (ok) this.afterRestore()
    return ok
  }

  async restoreNamed(name: string): Promise<boolean> {
    return this.restoreBytes(await this.storage.read(name))
  }

  /** Bytes of the library right now, for the share sheet. */
  snapshot(): Uint8Array {
    return this.db.exportBytes()
  }
}

// ------------------------------------------------------------------ browser helpers used by the phone backend
/** Opens Android's file chooser; resolves with the chosen file's bytes, or null if the owner cancelled. */
export function pickFileBytes(accept = '.sqlite,application/octet-stream,application/x-sqlite3'): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.style.position = 'fixed'
    input.style.left = '-9999px'
    let settled = false
    const done = (v: Uint8Array | null): void => {
      if (settled) return
      settled = true
      input.remove()
      resolve(v)
    }
    input.addEventListener('change', () => {
      const f = input.files?.[0]
      if (!f) return done(null)
      f.arrayBuffer().then((b) => done(new Uint8Array(b)), () => done(null))
    })
    input.addEventListener('cancel', () => done(null))
    document.body.appendChild(input)
    input.click()
  })
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(bin)
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
