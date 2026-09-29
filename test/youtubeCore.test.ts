import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  cleanTrackTitle,
  extractStreams,
  isVideoId,
  isYouTubeUrl,
  parsePlaylist,
  parseSearch,
  parseVideoMeta,
  playlistToResults,
  songTagsFor,
  streamExpiry,
  videoIdFromUrl
} from '../src/renderer/src/platform/youtubeCore'

// The fixtures are real yt-dlp output (yt-dlp 2026.08.19), trimmed and with the requester's address removed.
const fx = (name: string): string => fs.readFileSync(path.join(__dirname, 'fixtures/yt', name), 'utf8')

describe('reading yt-dlp output (real fixtures)', () => {
  it('search results become rows with id, title, channel, duration and a thumbnail', () => {
    const rows = parseSearch(fx('search.json'))
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      provider: 'youtube',
      id: 'youtube:4ucog3jt95Q',
      videoId: '4ucog3jt95Q',
      url: 'https://www.youtube.com/watch?v=4ucog3jt95Q',
      artist: 'SonyMusicSouthVEVO',
      duration: 416
    })
    expect(rows[0].title).toContain('Vinnaithaandi')
    expect(rows[0].artworkUrl).toMatch(/^https:\/\/i\.ytimg\.com\//)
    expect(parseSearch('not json')).toEqual([])
    expect(parseSearch('{"entries":[{"id":"short","title":"x"}]}')).toEqual([]) // ids must be 11 characters
  })

  it('a playlist keeps its order and reports when it was cut short', () => {
    const all = parsePlaylist(fx('playlist.json'), false, 200)
    expect(all.entries.map((e) => e.videoId)).toEqual(parseSearch(fx('search.json')).map((r) => r.videoId))
    expect(all.title).toBe('Harness playlist')
    expect(all.capped).toBe(false)
    const cut = parsePlaylist(fx('playlist.json'), false, 2)
    expect(cut.entries).toHaveLength(2)
    expect(cut.capped).toBe(true)
    // a Mix never ends: reaching the limit always counts as cut short
    expect(parsePlaylist(fx('playlist.json'), true, 3).capped).toBe(true)
    expect(parsePlaylist('{"entries":[]}', false, 10).error).toMatch(/No playable/)
    expect(parsePlaylist('garbage', false, 10).error).toMatch(/Could not read/)
    const rows = playlistToResults(all)
    expect(rows[0]).toMatchObject({ id: 'youtube:4ucog3jt95Q', album: 'Harness playlist' })
  })

  it('a video description gives its tags and only safe request headers', () => {
    const meta = parseVideoMeta(fx('stream.json'))
    expect(meta?.title).toContain('Vinnaithaandi')
    expect(meta?.channel).toBe('SonyMusicSouthVEVO')
    expect(meta?.duration).toBe(416)
    const streams = extractStreams(fx('stream.json'))
    expect(streams.urls.length).toBeGreaterThan(0)
    for (const u of streams.urls) {
      expect(u).toMatch(/^https:\/\//)
      expect(Object.keys(streams.headers[u]).every((k) => /^(user-agent|accept|accept-language|referer|origin)$/i.test(k))).toBe(true)
      expect(JSON.stringify(streams.headers[u]).toLowerCase()).not.toContain('cookie')
    }
    expect(Object.values(streams.headers).some((h) => h['User-Agent'])).toBe(true)
  })
})

describe('choosing streams', () => {
  const fmt = (o: Record<string, unknown>): Record<string, unknown> => ({ acodec: 'none', vcodec: 'none', ...o })
  const json = (formats: unknown[]): string => JSON.stringify({ formats, http_headers: { 'User-Agent': 'UA', Cookie: 'secret=1' } })

  it('MP4/AAC audio first (best bitrate first), then other audio, then muxed; manifests are skipped', () => {
    const s = extractStreams(
      json([
        fmt({ url: 'https://x/webm160', ext: 'webm', acodec: 'opus', abr: 160 }),
        fmt({ url: 'https://x/m4a128', ext: 'm4a', acodec: 'mp4a.40.2', abr: 128 }),
        fmt({ url: 'https://x/m4a48', ext: 'm4a', acodec: 'mp4a.40.5', abr: 48 }),
        { url: 'https://x/muxed', ext: 'mp4', acodec: 'mp4a', vcodec: 'avc1', tbr: 600 },
        fmt({ url: 'https://x/live.m3u8', ext: 'mp4', acodec: 'mp4a', abr: 999 }),
        fmt({ url: 'https://x/dash.mpd', ext: 'mp4', acodec: 'mp4a', abr: 999 }),
        fmt({ url: 'ftp://x/other', ext: 'm4a', acodec: 'mp4a', abr: 999 }),
        { url: 'https://x/video-only', ext: 'mp4', acodec: 'none', vcodec: 'avc1', tbr: 5000 }
      ])
    )
    expect(s.urls).toEqual(['https://x/m4a128', 'https://x/m4a48', 'https://x/webm160', 'https://x/muxed'])
    expect(s.headers['https://x/m4a128']).toEqual({ 'User-Agent': 'UA' }) // the cookie is dropped
  })

  it('bad input gives nothing', () => {
    expect(extractStreams('nope')).toEqual({ urls: [], headers: {} })
    expect(extractStreams('{}').urls).toEqual([])
  })

  it('addresses are remembered until shortly before YouTube stops accepting them', () => {
    const now = 1_000_000_000_000
    const soon = Math.floor(now / 1000) + 3 * 3600
    expect(streamExpiry([`https://x/videoplayback?expire=${soon}&a=b`], now)).toBe(soon * 1000 - 10 * 60_000)
    const far = Math.floor(now / 1000) + 24 * 3600
    expect(streamExpiry([`https://x/videoplayback?expire=${far}`], now)).toBe(now + 5.5 * 3600_000)
    expect(streamExpiry(['https://x/no-expiry'], now)).toBe(now + 15 * 60_000)
    expect(streamExpiry([`https://x/videoplayback?expire=${Math.floor(now / 1000) + 60}`], now)).toBe(now + 60_000)
  })
})

describe('YouTube addresses', () => {
  it('finds the video id in every form and refuses other sites', () => {
    const id = 'dQw4w9WgXcQ'
    for (const u of [
      `https://www.youtube.com/watch?v=${id}`,
      `https://youtu.be/${id}?t=5`,
      `https://m.youtube.com/watch?v=${id}&list=RD${id}`,
      `https://music.youtube.com/watch?v=${id}`,
      `https://www.youtube.com/shorts/${id}`,
      `https://www.youtube.com/embed/${id}`,
      `https://www.youtube.com/live/${id}`
    ]) {
      expect(videoIdFromUrl(u), u).toBe(id)
    }
    expect(videoIdFromUrl('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull()
    expect(videoIdFromUrl('https://www.youtube.com/watch?v=short')).toBeNull()
    expect(videoIdFromUrl('not a url')).toBeNull()
    expect(isYouTubeUrl('https://youtu.be/x')).toBe(true)
    expect(isYouTubeUrl('https://evil.example/youtube.com')).toBe(false)
    expect(isVideoId('dQw4w9WgXcQ')).toBe(true)
    expect(isVideoId('../etc/passwd')).toBe(false)
  })
})

describe('tags for downloaded songs', () => {
  it('cleans the usual noise out of titles', () => {
    expect(cleanTrackTitle('Kannamma - Video Song (Official) | Sony Music')).toBe('Kannamma')
    expect(cleanTrackTitle('Artist - Song [Lyric Video] (HD)')).toBe('Artist - Song')
    expect(cleanTrackTitle('')).toBe('')
  })

  it('YouTube Music tags win, then Topic channels, then "Artist - Title", then the channel', () => {
    expect(songTagsFor('x', 'y', { track: 'Real title', artist: 'Real artist', album: 'Real album' })).toEqual({
      title: 'Real title',
      artist: 'Real artist',
      album: 'Real album'
    })
    expect(songTagsFor('Some Song', 'The Band - Topic')).toEqual({ title: 'Some Song', artist: 'The Band', album: '' })
    expect(songTagsFor('The Band - Some Song (Official Video)', 'Whatever')).toEqual({ title: 'Some Song', artist: 'The Band', album: '' })
    expect(songTagsFor('Just A Title (Lyrics)', 'ChannelVEVO')).toEqual({ title: 'Just A Title', artist: 'Channel', album: '' })
    expect(songTagsFor('', null).artist).toBe('Unknown Artist')
  })
})
