import { describe, expect, it } from 'vitest'
import {
  buildDownloadUrl,
  buildSearchUrl,
  cleanQuery,
  formatRank,
  isValidIdentifier,
  parseHits,
  parseItem,
  parseLength,
  pickCover
} from '../src/main/services/archive'

describe('archive helpers', () => {
  it('accepts only real archive.org identifiers', () => {
    expect(isValidIdentifier('headphonica.hpcd073')).toBe(true)
    expect(isValidIdentifier('78_jewish-music_x')).toBe(true)
    expect(isValidIdentifier('../etc/passwd')).toBe(false)
    expect(isValidIdentifier('a b')).toBe(false)
    expect(isValidIdentifier('')).toBe(false)
    expect(isValidIdentifier(42)).toBe(false)
  })

  it('strips query syntax so user text cannot change the search', () => {
    expect(cleanQuery('bach" OR (mediatype:movies)')).toBe('bach OR mediatype movies')
    expect(buildSearchUrl('   ', 1, true)).toBeNull()
  })

  it('builds a lossless search url', () => {
    const url = new URL(buildSearchUrl('bach cello', 2, true) as string)
    expect(url.origin + url.pathname).toBe('https://archive.org/advancedsearch.php')
    expect(url.searchParams.get('q')).toContain('mediatype:audio')
    expect(url.searchParams.get('q')).toContain('"24bit Flac"')
    expect(url.searchParams.get('page')).toBe('2')
    const all = new URL(buildSearchUrl('bach', 1, false) as string)
    expect(all.searchParams.get('q')).not.toContain('format:')
  })

  it('encodes file names in download urls', () => {
    expect(buildDownloadUrl('id.1', 'Track 01 #1.flac')).toBe(
      'https://archive.org/download/id.1/Track%2001%20%231.flac'
    )
    expect(buildDownloadUrl('id.1', 'disc 1/01.flac')).toBe('https://archive.org/download/id.1/disc%201/01.flac')
  })

  it('ranks lossless above lossy and drops non-audio', () => {
    expect(formatRank('24bit Flac')).toBeLessThan(formatRank('Flac'))
    expect(formatRank('Flac')).toBeLessThan(formatRank('VBR MP3'))
    expect(formatRank('JPEG')).toBe(-1)
  })

  it('parses lengths in seconds or m:ss', () => {
    expect(parseLength('10406.5')).toBe(10406.5)
    expect(parseLength('3:25')).toBe(205)
    expect(parseLength('1:02:03')).toBe(3723)
    expect(parseLength('x')).toBeNull()
    expect(parseLength(undefined)).toBeNull()
  })

  it('parses search hits, including array creators', () => {
    const { hits, total } = parseHits({
      response: {
        numFound: 7,
        docs: [
          { identifier: 'a.b', title: 'T', creator: ['X', 'Y'], year: '1999', downloads: 5, licenseurl: 'http://l' },
          { identifier: '../bad', title: 'no' },
          { identifier: 'c' }
        ]
      }
    })
    expect(total).toBe(7)
    expect(hits).toHaveLength(2)
    expect(hits[0]).toMatchObject({ identifier: 'a.b', creator: 'X, Y', year: 1999, downloads: 5 })
    expect(hits[1].title).toBe('c')
    expect(parseHits(null)).toEqual({ hits: [], total: 0 })
  })

  it('parses an item: audio only, best format first, tracks in order', () => {
    const item = parseItem('id', {
      metadata: { title: 'Album', creator: 'Band', date: '2001-01-01' },
      files: [
        { name: 'cover.jpg', format: 'JPEG' },
        { name: '02.mp3', format: 'VBR MP3', size: '100', track: '02' },
        { name: '02.flac', format: 'Flac', size: '900', track: '02', md5: 'abc', length: '3:00' },
        { name: '10.flac', format: 'Flac', size: '900', track: '10' },
        { name: '01.flac', format: 'Flac', size: '900', track: '01', title: 'One', artist: 'Band' }
      ]
    })
    expect(item.title).toBe('Album')
    expect(item.files.map((f) => f.name)).toEqual(['01.flac', '02.flac', '10.flac', '02.mp3'])
    expect(item.files[0]).toMatchObject({ label: 'FLAC', lossless: true, title: 'One' })
    expect(item.files[1]).toMatchObject({ md5: 'abc', durationSec: 180, size: 900 })
    expect(item.files[3].lossless).toBe(false)
  })

  it('keeps real pictures of an item and picks the best cover for a track', () => {
    const item = parseItem('id', {
      metadata: { title: 'A' },
      files: [
        { name: 'One.flac', format: 'Flac', size: '9' },
        { name: 'One.png', format: 'PNG', size: '500' },
        { name: 'Two.flac', format: 'Flac', size: '9' },
        { name: 'front.jpg', format: 'JPEG', size: '100' },
        { name: 'big.jpg', format: 'JPEG', size: '900' },
        { name: '__ia_thumb.jpg', format: 'Item Tile', size: '4' },
        { name: 'One_spectrogram.png', format: 'Spectrogram', size: '300' }
      ]
    })
    expect(item.images.map((i) => i.name)).toEqual(['One.png', 'front.jpg', 'big.jpg'])
    expect(pickCover(item.images, 'One.flac')?.name).toBe('One.png')
    expect(pickCover(item.images, 'Two.flac')?.name).toBe('front.jpg')
    expect(pickCover([{ name: 'x.jpg', size: 1 }, { name: 'y.jpg', size: 5 }], 'Two.flac')?.name).toBe('y.jpg')
    expect(pickCover([], 'a.flac')).toBeNull()
  })
})
