import { getEmbeddedArtwork } from './ipc'

/**
 * Artwork URLs are identical for the life of a song ("cyttos-art://artwork/
 * song:id"), which makes Chromium reuse the stale cached image after a
 * metadata fix re-embeds a new cover. The revision counter is bumped on
 * every library change (fix, rescan, tag edit) so the URL gains a fresh
 * query string and the renderer refetches the artwork.
 */
let artworkRevision = 0

export function bumpArtworkRevision(): void {
  artworkRevision++
}

/** Only valid when the song actually has embedded artwork cached. */
export function embeddedArtworkUrl(songId: string | null | undefined): string | null {
  if (!songId) return null
  return `cyttos-art://artwork/${encodeURIComponent(songId)}?v=${artworkRevision}`
}

/**
 * Resolve artwork for a track: embedded art first, then folder artwork
 * discovered by the main process.
 */
export async function resolveTrackArtwork(songId: string | null | undefined): Promise<string | null> {
  if (!songId) return null
  const direct = embeddedArtworkUrl(songId)
  if (direct) return direct
  return getEmbeddedArtwork(songId)
}
