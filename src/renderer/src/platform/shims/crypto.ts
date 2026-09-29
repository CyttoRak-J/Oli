/** Stand-in for node:crypto: only what the shared services use on the phone (random ids). */
function bytes(n: number): Uint8Array {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return b
}

export function randomBytes(n: number): Uint8Array & { toString: (encoding?: string) => string } {
  const b = bytes(n) as Uint8Array & { toString: (encoding?: string) => string }
  b.toString = (): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return b
}

export function randomUUID(): string {
  return crypto.randomUUID()
}

/** Hashing files/strings synchronously is only needed by the desktop scanner. The phone scanner uses native code. */
export function createHash(): never {
  throw new Error('createHash is not available in the Android web view')
}
