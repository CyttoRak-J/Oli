export type DetectedLink =
  | { kind: 'video'; videoId: string }
  | { kind: 'playlist'; playlistUrl: string }
  | { kind: 'both'; videoId: string; playlistUrl: string }

/** Classify a pasted URL: single video, a playlist, or a watch URL that also
 *  carries a playlist (e.g. radio mixes) where the user can pick either. */
export function detectYtInput(raw: string): DetectedLink | null {
  const trimmed = raw.trim()
  try {
    const u = new URL(trimmed)
    const host = u.hostname.replace(/^(www\.|m\.|music\.)/i, '')
    if (host === 'youtube.com' || host === 'youtu.be') {
      const short = /^\/([\w-]{11})\/?$/.exec(u.pathname)
      if (short) return { kind: 'video', videoId: short[1] }
      const m = /^\/(?:shorts|embed)\/([\w-]{11})/.exec(u.pathname)
      if (m) return { kind: 'video', videoId: m[1] }
      if (u.pathname === '/watch') {
        const v = u.searchParams.get('v')
        if (v && /^[\w-]{11}$/.test(v)) {
          if (u.searchParams.get('list')) return { kind: 'both', videoId: v, playlistUrl: trimmed }
          return { kind: 'video', videoId: v }
        }
      }
      if (u.pathname === '/playlist' && u.searchParams.get('list')) {
        return { kind: 'playlist', playlistUrl: trimmed }
      }
    }
    if (host === 'open.spotify.com' && u.pathname.startsWith('/playlist/')) {
      return { kind: 'playlist', playlistUrl: trimmed }
    }
  } catch {
    // not a URL; check the spotify: URI form below
  }
  if (/^spotify:playlist:[A-Za-z0-9]+/.test(trimmed)) {
    return { kind: 'playlist', playlistUrl: trimmed }
  }
  return null
}