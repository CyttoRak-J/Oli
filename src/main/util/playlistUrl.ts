/**
 * Where to point yt-dlp for a pasted YouTube playlist link.
 *
 * YouTube "Mix" / radio playlists (list=RD...) exist only relative to a video:
 * `youtube.com/playlist?list=RD<id>` is answered with "This playlist type is
 * unviewable", while `watch?v=<id>&list=RD<id>` works. Ordinary playlists work
 * either way, so the watch form is used whenever a video id is known.
 */
export interface PlaylistTarget {
  /** URL to hand to yt-dlp. */
  url: string
  listId: string
  videoId: string | null
  /** Auto-generated, endless Mix (as opposed to a real, finite playlist). */
  isMix: boolean
}

const VIDEO_ID = /^[\w-]{11}$/

export function playlistTarget(raw: string): PlaylistTarget | null {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  const host = u.hostname.replace(/^(www\.|m\.|music\.)/i, '')
  if (host !== 'youtube.com' && host !== 'youtu.be') return null
  const listId = u.searchParams.get('list')
  if (!listId || !/^[\w-]+$/.test(listId)) return null
  let videoId = u.searchParams.get('v')
  if (!videoId && host === 'youtu.be') videoId = u.pathname.replace(/^\//, '')
  if (!videoId || !VIDEO_ID.test(videoId)) videoId = null
  // RDCLAK... are curated YouTube Music playlists: real and viewable.
  const isMix = /^RD/.test(listId) && !/^RDCLAK/.test(listId)
  return {
    url: videoId
      ? `https://www.youtube.com/watch?v=${videoId}&list=${listId}`
      : `https://www.youtube.com/playlist?list=${listId}`,
    listId,
    videoId,
    isMix
  }
}

/** Songs to list for a playlist: a Mix never ends, so it is cut short (listing 300 Mix songs takes about 14 s, 500 about 15 s). */
export const PLAYLIST_LIMIT = 2000
export const MIX_LIMIT = 500
