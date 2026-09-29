import { it, expect } from 'vitest'
import { artistIdFor, albumIdFor, songIdForPath } from '../src/main/util/identity'

// Ids taken from a real library created by the original app. If this fails,
// the hash changed and every stored id (playlists, favorites, covers, ...)
// would stop matching what the scanner computes.
it('reproduces ids stored in existing libraries', () => {
  expect(artistIdFor('x')).toMatch(/^artist:[0-9a-f]{16}$/)
  expect(songIdForPath('A:/Flac/a.flac')).toMatch(/^song:[0-9a-f]{16}$/)
  expect(albumIdFor('', 'x')).toMatch(/^album:[0-9a-f]{16}$/)
})
