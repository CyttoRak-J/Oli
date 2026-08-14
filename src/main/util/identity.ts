import * as path from 'node:path'

/**
 * Stable 64-bit identity hashing for library entities (songs, artists,
 * albums). Ids are pure functions of names/paths so the same entity always
 * resolves to the same id, regardless of which code path created it. All
 * producers (scanner, metadata ops, playlists) MUST use these helpers.
 */

export function hash64(input: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')
}

/** Canonical name normalization for identity derivation. */
export function identityKey(input: string): string {
  return input.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

export function artistIdFor(name: string): string {
  return `artist:${hash64(identityKey(name))}`
}

export function albumIdFor(albumArtist: string, album: string): string {
  // Compilations/OSTs often have no album-artist tag; keying by title alone
  // then keeps every track of the same album together (per-song artist would
  // fragment it into one-album-per-singer). An explicit album-artist tag
  // still scopes identity so two same-titled albums by different artists
  // stay separate.
  const albumKey = identityKey(album)
  const artistKey = albumArtist.trim() ? identityKey(albumArtist) : ''
  return `album:${hash64(artistKey ? `${artistKey}|${albumKey}` : albumKey)}`
}

export function songIdForPath(filePath: string): string {
  return `song:${hash64(path.resolve(filePath).toLowerCase())}`
}
