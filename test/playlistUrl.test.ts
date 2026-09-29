import { describe, it, expect } from 'vitest'
import { playlistTarget } from '../src/main/util/playlistUrl'

describe('playlistTarget', () => {
  it('opens a YouTube Mix through its watch URL (the playlist URL is "unviewable")', () => {
    const t = playlistTarget('https://www.youtube.com/watch?v=zmeHQsFYOYg&list=RDzmeHQsFYOYg&start_radio=1')
    expect(t).toEqual({
      url: 'https://www.youtube.com/watch?v=zmeHQsFYOYg&list=RDzmeHQsFYOYg',
      listId: 'RDzmeHQsFYOYg',
      videoId: 'zmeHQsFYOYg',
      isMix: true
    })
  })

  it('recognises a Mix from a bare playlist URL but has no video to open it with', () => {
    const t = playlistTarget('https://www.youtube.com/playlist?list=RDzmeHQsFYOYg')
    expect(t?.isMix).toBe(true)
    expect(t?.videoId).toBeNull()
  })

  it('treats ordinary playlists as finite, from any host form', () => {
    expect(playlistTarget('https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI')).toMatchObject({
      url: 'https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI',
      isMix: false
    })
    expect(playlistTarget('https://youtu.be/zmeHQsFYOYg?list=PLabc123')).toMatchObject({
      url: 'https://www.youtube.com/watch?v=zmeHQsFYOYg&list=PLabc123',
      isMix: false
    })
    expect(playlistTarget('https://music.youtube.com/watch?v=zmeHQsFYOYg&list=RDCLAKxyz')?.isMix).toBe(false)
  })

  it('ignores anything that is not a YouTube playlist link', () => {
    expect(playlistTarget('https://www.youtube.com/watch?v=zmeHQsFYOYg')).toBeNull()
    expect(playlistTarget('https://example.com/watch?v=zmeHQsFYOYg&list=RDx')).toBeNull()
    expect(playlistTarget('not a url')).toBeNull()
  })
})
