import { describe, it, expect } from 'vitest'
import { hash64, identityKey, artistIdFor, albumIdFor, songIdForPath } from '../src/main/util/identity'

describe('identity hashing', () => {
  it('hash64 is deterministic for the same input', () => {
    expect(hash64('hello world')).toBe(hash64('hello world'))
  })

  it('hash64 produces different output for different input', () => {
    expect(hash64('artist a')).not.toBe(hash64('artist b'))
  })

  it('hash64 is sensitive to small differences (avalanche-ish)', () => {
    const a = hash64('taylor swift')
    const b = hash64('taylor swifs')
    expect(a).not.toBe(b)
  })

  it('does not collide across a moderately large sample of similar strings', () => {
    // This is exactly the risk the previous non-cryptographic hash carried:
    // near-identical library entries (e.g. "Artist feat. X" variants) landing
    // on the same id and silently merging two different entities.
    const seen = new Set<string>()
    for (let i = 0; i < 20000; i++) {
      const h = hash64(`Track Title ${i} - Some Artist`)
      expect(seen.has(h)).toBe(false)
      seen.add(h)
    }
  })

  it('identityKey normalizes case, accents, and punctuation consistently', () => {
    expect(identityKey('Café Del Mar')).toBe(identityKey('cafe del mar'.normalize('NFKD')))
    expect(identityKey("Guns N' Roses")).toBe(identityKey('Guns N Roses'))
  })

  it('artistIdFor is stable and prefixed', () => {
    const id = artistIdFor('Radiohead')
    expect(id.startsWith('artist:')).toBe(true)
    expect(artistIdFor('Radiohead')).toBe(id)
    expect(artistIdFor('radiohead')).toBe(id) // case-insensitive identity
  })

  it('albumIdFor scopes by album-artist when present, falls back to title-only for compilations', () => {
    const withArtist = albumIdFor('Various Artists', 'Now Thats What I Call Music')
    const compilation = albumIdFor('', 'Now Thats What I Call Music')
    expect(withArtist).not.toBe(compilation)

    // Same album+artist should always resolve to the same album id
    expect(albumIdFor('Pink Floyd', 'The Wall')).toBe(albumIdFor('Pink Floyd', 'The Wall'))

    // Same title, different artist scoping -> different albums (compilation vs single-artist)
    expect(albumIdFor('Pink Floyd', 'Greatest Hits')).not.toBe(albumIdFor('', 'Greatest Hits'))
  })

  it('songIdForPath is case-insensitive and path-normalized on the same OS', () => {
    const a = songIdForPath('C:/Music/song.mp3')
    const b = songIdForPath('c:/Music/song.mp3')
    expect(a).toBe(b)
  })
})
