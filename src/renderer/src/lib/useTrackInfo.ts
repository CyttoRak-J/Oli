import { useNavigate } from 'react-router-dom'
import { openVideoWindow } from './ipc'
import type { Track } from '@shared/types'

/**
 * Open the info view for a track: the song detail page for library tracks,
 * the video window for online (YouTube) tracks.
 */
export function useTrackInfo(): (track: Track | null | undefined) => void {
  const navigate = useNavigate()
  return (track) => {
    if (!track) return
    if (track.path) {
      navigate(`/song/${track.id}`)
      return
    }
    const vid = track.id.startsWith('youtube:') ? track.id.slice('youtube:'.length) : ''
    if (vid) void openVideoWindow(vid)
  }
}