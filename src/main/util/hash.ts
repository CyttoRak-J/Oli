import * as crypto from 'node:crypto'

/**
 * Streaming content fingerprint used by the scanner.
 *
 * Hashes file size, mtime and up to the first 256KB of content. This is strong
 * enough to detect added/renamed/moved/modified files without having to read
 * entire multi-hundred-MB FLACs on every rescan. A full-content hash is only
 * computed on demand for duplicate-group verification.
 */
export function streamFingerprint(size: number, mtimeMs: number, buffer: Buffer): string {
  const h = crypto.createHash('sha1')
  h.update(String(size)).update('#').update(String(mtimeMs)).update('#').update(buffer)
  return h.digest('hex').slice(0, 20)
}

export function contentHashFile(buffer: Buffer): string {
  return crypto.createHash('sha1').update(buffer).digest('hex')
}

export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

/** Deterministic short hash of a string (folder IDs, stable keys). */
export function hashString(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16)
}

export function randomId(): string {
  return crypto.randomBytes(16).toString('hex')
}