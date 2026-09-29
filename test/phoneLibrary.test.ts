import { describe, expect, it, beforeEach } from 'vitest'
import * as os from 'node:os'
import { Database } from '../src/main/services/database'
import { runMigrations } from '../src/main/services/migrations'
import { LibraryQueries } from '../src/main/services/libraryQueries'
import { initLogger } from '../src/main/services/logger'
import { albumIdFor, artistIdFor, songIdForPath } from '../src/main/util/identity'
import {
  PHONE_LIBRARY_ID,
  PhoneLibrary,
  codecFromMime,
  parseGain,
  probeToPatch,
  rowToTrack,
  type MediaRow,
  type OliMediaPlugin,
  type ProbeResult
} from '../src/renderer/src/platform/phoneLibrary'
import { createPhoneStore } from '../src/renderer/src/platform/phoneStore'
import type { ScanProgress } from '../src/shared/types'

initLogger(os.tmpdir())

function row(n: number, over: Partial<MediaRow> = {}): MediaRow {
  return {
    id: n,
    uri: `content://media/external/audio/media/${n}`,
    title: `Song ${n}`,
    artist: 'Artist',
    album: 'Album',
    albumArtist: '',
    composer: '',
    genre: 'Pop',
    year: 2020,
    trackNo: n,
    discNo: 0,
    durationMs: 200000,
    size: 30_000_000,
    modifiedSec: 1000 + n,
    addedSec: 500,
    displayName: `song-${n}.flac`,
    mime: 'audio/flac',
    bitrate: 0,
    key: `Music/Album/song-${n}.flac`,
    ...over
  }
}

function fakePlugin(state: { rows: MediaRow[]; granted: boolean; probes: Record<string, Partial<ProbeResult>> }): {
  plugin: OliMediaPlugin
  calls: string[]
} {
  const calls: string[] = []
  const plugin = {
    getPermission: async () => ({ granted: state.granted }),
    requestPermission: async () => {
      calls.push('requestPermission')
      return { granted: state.granted }
    },
    queryAudio: async ({ offset, limit }: { offset: number; limit: number }) => {
      calls.push(`queryAudio@${offset}`)
      return { rows: state.rows.slice(offset, offset + limit) }
    },
    probeFiles: async ({ uris }: { uris: string[] }) => {
      calls.push(`probe x${uris.length}`)
      return { results: uris.map((uri) => ({ uri, ...(state.probes[uri] ?? {}) })) }
    },
    getArtwork: async ({ key }: { uri: string; key: string }) => {
      calls.push(`art ${key}`)
      return key.startsWith('album:') ? { path: `/cache/art/${key}.jpg` } : {}
    },
    clearArtworkCache: async () => undefined,
    addListener: async () => ({ remove: async () => undefined })
  } as unknown as OliMediaPlugin
  return { plugin, calls }
}

describe('MediaStore row -> Track', () => {
  it('makes the same ids the desktop scanner makes for the same names', () => {
    const t = rowToTrack(row(1, { albumArtist: 'Band' }))
    expect(t.id).toBe(songIdForPath('Music/Album/song-1.flac'))
    expect(t.artistId).toBe(artistIdFor('Artist'))
    expect(t.albumId).toBe(albumIdFor('Band', 'Album'))
    expect(t.albumArtist).toBe('Band')
    // no album-artist tag: the album is keyed by its title alone, like on the desktop
    expect(rowToTrack(row(2)).albumId).toBe(albumIdFor('', 'Album'))
    expect(rowToTrack(row(2)).albumArtist).toBe('Artist')
  })

  it('fills the columns the screens use', () => {
    const t = rowToTrack(row(3, { discNo: 2, bitrate: 320000, mime: 'audio/mpeg', displayName: 'x.mp3' }))
    expect(t).toMatchObject({
      title: 'Song 3',
      duration: 200,
      trackNo: 3,
      discNo: 2,
      bitrate: 320000,
      codec: 'mp3',
      format: 'MP3',
      year: 2020,
      path: 'content://media/external/audio/media/3',
      libraryId: PHONE_LIBRARY_ID,
      sampleRate: null,
      bitDepth: null,
      hasEmbeddedArtwork: false,
      modifiedAt: 1003 * 1000
    })
  })

  it('replaces missing tags with the same fallbacks as elsewhere in the app', () => {
    const t = rowToTrack(row(4, { title: '<unknown>', artist: '<unknown>', album: '', displayName: 'Nice Tune.opus', mime: 'audio/ogg' }))
    expect(t.title).toBe('Nice Tune')
    expect(t.artist).toBe('Unknown Artist')
    expect(t.album).toBe('Unknown Album')
    expect(t.format).toBe('OPUS')
  })

  it('understands codecs and gains', () => {
    expect(codecFromMime('audio/flac')).toBe('flac')
    expect(codecFromMime('audio/mp4a-latm')).toBe('aac')
    expect(codecFromMime('audio/alac')).toBe('alac')
    expect(codecFromMime('audio/x-wav')).toBe('pcm')
    expect(parseGain('-7.23 dB')).toBe(-7.23)
    expect(parseGain('')).toBeNull()
    expect(parseGain('abc')).toBeNull()
  })

  it('turns a file probe into a database patch (bit depth only for lossless)', () => {
    expect(
      probeToPatch({ uri: 'u', container: 'flac', mime: '', sampleRate: 96000, channels: 2, bitDepth: 24, trackGain: '-6.5 dB', albumGain: '-7.1 dB', isrc: 'X1' }, {})
    ).toEqual({ sampleRate: 96000, channels: 2, bitDepth: 24, codec: 'flac', replayGain: -6.5, replayGainAlbum: -7.1, isrc: 'X1' })
    const mp3 = probeToPatch({ uri: 'u', mime: 'audio/mpeg', sampleRate: 44100, channels: 2, bitDepth: 16 }, {})
    expect(mp3.bitDepth).toBeUndefined()
    expect(mp3.codec).toBe('mp3')
    expect(probeToPatch({ uri: 'u', error: 'boom' }, {})).toEqual({ sampleRate: 0 })
  })
})

describe('scanning the phone', () => {
  let db: Database
  let store: ReturnType<typeof createPhoneStore>
  let library: LibraryQueries
  let progress: ScanProgress[]
  const state = { rows: [] as MediaRow[], granted: true, probes: {} as Record<string, Partial<ProbeResult>> }

  beforeEach(async () => {
    db = new Database({ file: `${os.tmpdir()}/oli-phone-${Date.now()}-${Math.random()}.sqlite` })
    await db.init()
    runMigrations(db)
    library = new LibraryQueries(db)
    store = createPhoneStore(db, library, () => undefined)
    progress = []
    state.granted = true
    state.probes = {}
    state.rows = [row(1), row(2), row(3, { album: 'Other', artist: 'Someone' })]
  })

  const make = (): { lib: PhoneLibrary; calls: string[] } => {
    const { plugin, calls } = fakePlugin(state)
    const lib = new PhoneLibrary({ plugin, store, emitProgress: (p) => progress.push(p) })
    return { lib, calls }
  }
  const count = (where = ''): number => db.count(`SELECT id FROM songs ${where}`)

  it('adds the songs, groups albums/artists and reads the details afterwards', async () => {
    state.probes = {
      'content://media/external/audio/media/1': { container: 'flac', sampleRate: 96000, channels: 2, bitDepth: 24, trackGain: '-5.00 dB' },
      'content://media/external/audio/media/2': { container: 'flac', sampleRate: 44100, channels: 2, bitDepth: 16 }
    }
    const { lib } = make()
    expect(await lib.addAndScan()).toBe(true)
    await lib.whenIdle()
    expect(count()).toBe(3)
    expect(db.count("SELECT id FROM albums")).toBe(2)
    const s1 = db.get<Record<string, unknown>>("SELECT * FROM songs WHERE title = 'Song 1'")!
    expect(s1.sample_rate).toBe(96000)
    expect(s1.bit_depth).toBe(24)
    expect(s1.replay_gain).toBe(-5)
    expect(s1.library_id).toBe(PHONE_LIBRARY_ID)
    // song 3 gave no details: marked as read (0), not left null forever
    expect(db.get<{ sample_rate: number }>("SELECT sample_rate FROM songs WHERE title = 'Song 3'")!.sample_rate).toBe(0)
    expect(progress.at(-1)?.phase).toBe('finished')
    expect(store.songsOf(PHONE_LIBRARY_ID)).toHaveLength(3)
    const folder = library.getFolders().find((f) => f.id === PHONE_LIBRARY_ID)
    expect(folder?.trackCount).toBe(3)
  })

  it('a second scan leaves unchanged songs alone (no probing again) and keeps favorites and play counts', async () => {
    const { lib, calls } = make()
    await lib.addAndScan()
    await lib.whenIdle()
    db.run("UPDATE songs SET favorite = 1, play_count = 7 WHERE title = 'Song 2'")
    calls.length = 0
    await lib.scan()
    expect(calls.some((c) => c.startsWith('probe'))).toBe(false)
    const s2 = db.get<{ favorite: number; play_count: number }>("SELECT favorite, play_count FROM songs WHERE title = 'Song 2'")!
    expect(s2).toEqual({ favorite: 1, play_count: 7 })
  })

  it('a changed file is re-read, a removed file is marked missing and comes back when it returns', async () => {
    const { lib } = make()
    await lib.addAndScan()
    await lib.whenIdle()
    state.rows = [row(1, { title: 'Song 1 (remaster)', modifiedSec: 9999 }), row(3, { album: 'Other', artist: 'Someone' })]
    state.probes = { 'content://media/external/audio/media/1': { container: 'flac', sampleRate: 192000, bitDepth: 24, channels: 2 } }
    await lib.scan()
    expect(db.get<{ title: string; sample_rate: number }>("SELECT title, sample_rate FROM songs WHERE id = ?", [songIdForPath('Music/Album/song-1.flac')])).toEqual({
      title: 'Song 1 (remaster)',
      sample_rate: 192000
    })
    expect(db.get<{ missing: number }>("SELECT missing FROM songs WHERE title = 'Song 2'")!.missing).toBe(1)
    expect(count('WHERE missing = 0')).toBe(2)
    expect(progress.at(-1)?.filesRemoved).toBe(1)
    state.rows = [row(1), row(2), row(3, { album: 'Other', artist: 'Someone' })]
    await lib.scan()
    expect(db.get<{ missing: number }>("SELECT missing FROM songs WHERE title = 'Song 2'")!.missing).toBe(0)
  })

  it('a moved song (same Android id, new folder) keeps working: the old row gives its path away', async () => {
    const { lib } = make()
    await lib.addAndScan()
    await lib.whenIdle()
    state.rows = [row(1, { key: 'Music/New/song-1.flac', modifiedSec: 5000 }), row(2), row(3, { album: 'Other', artist: 'Someone' })]
    await lib.scan()
    expect(count()).toBe(4) // the old id stays (missing) so playlists and history keep pointing at something
    expect(db.get<{ missing: number }>('SELECT missing FROM songs WHERE id = ?', [songIdForPath('Music/Album/song-1.flac')])!.missing).toBe(1)
    expect(db.get<{ missing: number }>('SELECT missing FROM songs WHERE id = ?', [songIdForPath('Music/New/song-1.flac')])!.missing).toBe(0)
  })

  it('pages through a big library (600 songs = 2 pages)', async () => {
    state.rows = Array.from({ length: 600 }, (_, i) => row(i + 1))
    const { lib, calls } = make()
    await lib.addAndScan()
    await lib.whenIdle()
    expect(calls.filter((c) => c.startsWith('queryAudio'))).toEqual(['queryAudio@0', 'queryAudio@500'])
    expect(count()).toBe(600)
    expect(calls.filter((c) => c.startsWith('probe'))).toHaveLength(30) // 20 per call
  })

  it('without permission it says so and adds nothing', async () => {
    state.granted = false
    const { lib } = make()
    expect(await lib.addAndScan()).toBe(false)
    expect(count()).toBe(0)
    expect(progress.at(-1)?.phase).toBe('error')
    expect(progress.at(-1)?.message).toMatch(/permission/i)
  })

  it('removing the location removes its songs but not others', async () => {
    db.run(
      "INSERT INTO songs (id, title, artist, album, duration, path, added_at, modified_at) VALUES ('dl1', 'Download', 'A', 'B', 10, 'file:///dl.flac', 1, 1)"
    )
    const { lib } = make()
    await lib.addAndScan()
    await lib.whenIdle()
    expect(count()).toBe(4)
    lib.remove()
    expect(count()).toBe(1)
  })

  it('finds cover art once per album and shares it between its songs', async () => {
    const { lib, calls } = make()
    await lib.addAndScan()
    await lib.whenIdle()
    const ids = store.songsOf(PHONE_LIBRARY_ID).map((r) => r.id)
    const toUrl = (p: string): string => `https://localhost/_capacitor_file_${p}`
    const a = await lib.artworkFor(ids[0], toUrl)
    const b = await lib.artworkFor(ids[1], toUrl)
    expect(a).toContain('/cache/art/album:')
    expect(b).toBe(a)
    expect(calls.filter((c) => c.startsWith('art '))).toHaveLength(1)
    expect(await lib.artworkFor('nope', toUrl)).toBeNull()
  })
})
