import { useState } from 'react'
import { Download as DownloadIcon, Loader2, Play } from 'lucide-react'
import { enqueuePlaylist, pickVideoFolder, videoDownload, videoDownloadSong, resolveYouTubeStreamBatch, resolvePlaylistEntries } from '../lib/ipc'
import { onlineToTrack } from '../lib/onlineTracks'
import { usePlayer } from '../store/player'
import type { DetectedLink } from '../lib/linkDetect'

const VIDEO_QUALITIES = [0, 2160, 1440, 1080, 720, 480, 360]

/**
 * Download form for a pasted YouTube/Spotify link. For a watch URL that also
 * carries a playlist (radio mixes etc.) the user picks between "this video"
 * (song/video + quality + audio) and "the whole playlist" (tagged audio or
 * stream playback).
 */
export function LinkDownloadForm({
  link,
  onEnqueued,
  onClose
}: {
  link: DetectedLink
  onEnqueued?: () => void
  onClose?: () => void
}): React.JSX.Element {
  const [scope, setScope] = useState<'video' | 'playlist'>(
    link.kind === 'both' ? 'video' : link.kind
  )
  const [format, setFormat] = useState<'song' | 'video'>('song')
  const [quality, setQuality] = useState(0)
  const [audio, setAudio] = useState<'best' | 'm4a' | 'opus'>('best')
  const [folder, setFolder] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')

  const isPlaylist = scope === 'playlist'
  const videoId = link.kind === 'video' || link.kind === 'both' ? link.videoId : null
  const playlistUrl = link.kind === 'playlist' || link.kind === 'both' ? link.playlistUrl : null
  const shownUrl = link.kind === 'both' ? (isPlaylist ? playlistUrl : videoId) : videoId ?? playlistUrl

  const playPlaylist = async (): Promise<void> => {
    if (!playlistUrl) return
    setBusy(true)
    setStatus('Resolving playlist…')
    try {
      const resolved = await resolvePlaylistEntries(playlistUrl)
      if (resolved.error) {
        setStatus(resolved.error)
        return
      }
      if (resolved.entries.length === 0) {
        setStatus('No songs found in that playlist')
        return
      }
      const entries = resolved.entries
      const INITIAL_BATCH = 8
      const firstBatch = entries.slice(0, INITIAL_BATCH)
      const rest = entries.slice(INITIAL_BATCH)
      const videoIds = firstBatch.map((e) => e.videoId)
      setStatus(`Loading first ${videoIds.length} songs…`)
      const batch = await resolveYouTubeStreamBatch(videoIds)
      const urlMap = new Map(batch.map((b) => [b.videoId, b.urls]))
      const toTrack = (entry: (typeof entries)[0]) => {
        const urls = urlMap.get(entry.videoId) ?? []
        return onlineToTrack(
          {
            provider: 'youtube',
            id: `youtube:${entry.videoId}`,
            title: entry.title,
            artist: entry.track?.artists?.join(', ') ?? 'YouTube',
            album: entry.track?.album ?? null,
            duration: entry.duration ?? null,
            year: null,
            artworkUrl: entry.thumbnail ?? null,
            url: `https://www.youtube.com/watch?v=${entry.videoId}`,
            previewUrl: null,
            videoId: entry.videoId
          },
          urls
        )
      }
      const initialTracks = firstBatch.map(toTrack).filter((t) => (t.streamUrls?.length ?? 0) > 0)
      const pendingTracks = rest.map((t) => { const track = toTrack(t); track.streamUrls = []; track.streamUrl = ''; return track })
      const tracks = [...initialTracks, ...pendingTracks]
      if (tracks.length === 0) {
        setStatus('Could not resolve any playable streams')
        return
      }
      usePlayer.getState().playTracks(tracks, 0, { source: 'search', sourceId: null })
      setStatus(`Playing — resolving remaining ${pendingTracks.length} songs in background…`)
      // Resolve remaining streams in background batches of 8
      void (async () => {
        const REMAINING_BATCH = 8
        for (let i = 0; i < rest.length; i += REMAINING_BATCH) {
          const slice = rest.slice(i, i + REMAINING_BATCH)
          const ids = slice.map((e) => e.videoId)
          try {
            const batch = await resolveYouTubeStreamBatch(ids)
            const batchMap = new Map(batch.map((b) => [b.videoId, b.urls]))
            const s = usePlayer.getState()
            const updated = s.queue.map((item) => {
              const vid = item.id.startsWith('youtube:') ? item.id.replace('youtube:', '') : null
              if (vid && batchMap.has(vid)) {
                const urls = batchMap.get(vid)!
                return urls.length > 0 ? { ...item, streamUrls: urls, streamUrl: urls[0] } : item
              }
              return item
            })
            usePlayer.setState({ queue: updated })
          } catch { /* ignore batch errors */ }
        }
        setStatus('')
      })()
    } catch (e) {
      setStatus(`Failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const start = async (): Promise<void> => {
    setBusy(true)
    setStatus('Starting…')
    try {
      const dest = folder.trim() || null
      if (isPlaylist && playlistUrl) {
        const res = await enqueuePlaylist(playlistUrl, audio, dest)
        setStatus(
          res.error
            ? res.error
            : res.enqueued > 0
              ? `Added ${res.enqueued} of ${res.found} songs${res.capped ? ' (playlist limited to 200)' : ''} — downloads started`
              : res.found === 0
                ? 'No songs found in that playlist'
                : 'Songs already in the list'
        )
        if (res.enqueued > 0) onEnqueued?.()
      } else if (videoId) {
        const id =
          format === 'song'
            ? await videoDownloadSong(videoId, audio, dest)
            : await videoDownload(videoId, quality, audio, dest)
        setStatus(
          id
            ? format === 'song'
              ? 'Download started — tagged audio file'
              : 'Download started — see the list below'
            : "Couldn't start"
        )
        if (id) onEnqueued?.()
      } else {
        setStatus('Nothing to download')
      }
    } catch {
      setStatus('Failed to start')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-accent/30 bg-surface-1 p-3">
      <div className="text-[13px] font-medium text-ink-0">
        {isPlaylist ? 'Download playlist — songs (tagged audio)' : 'YouTube download options'}
        <span className="ml-2 block truncate rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-3">
          {shownUrl}
        </span>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        {link.kind === 'both' && (
          <label className="flex flex-col gap-1 text-[11.5px] text-ink-3">
            Scope
            <select
              className="rounded-lg border border-surface-4 bg-surface-2 px-2 py-1.5 text-[12.5px] text-ink-0 outline-none focus:border-accent"
              value={scope}
              onChange={(e) => setScope(e.target.value as 'video' | 'playlist')}
            >
              <option value="video">This video only</option>
              <option value="playlist">Entire playlist</option>
            </select>
          </label>
        )}
        {!isPlaylist && (
          <>
            <label className="flex flex-col gap-1 text-[11.5px] text-ink-3">
              Format
              <select
                className="rounded-lg border border-surface-4 bg-surface-2 px-2 py-1.5 text-[12.5px] text-ink-0 outline-none focus:border-accent"
                value={format}
                onChange={(e) => setFormat(e.target.value as 'song' | 'video')}
              >
                <option value="song">Song (tagged audio)</option>
                <option value="video">Video</option>
              </select>
            </label>
            {format === 'video' && (
              <label className="flex flex-col gap-1 text-[11.5px] text-ink-3">
                Video quality
                <select
                  className="rounded-lg border border-surface-4 bg-surface-2 px-2 py-1.5 text-[12.5px] text-ink-0 outline-none focus:border-accent"
                  value={quality}
                  onChange={(e) => setQuality(Number(e.target.value))}
                >
                  {VIDEO_QUALITIES.map((q) => (
                    <option key={q} value={q}>
                      {q === 0 ? 'Best' : `${q}p`}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}
        <label className="flex flex-col gap-1 text-[11.5px] text-ink-3">
          Audio
          <select
            className="rounded-lg border border-surface-4 bg-surface-2 px-2 py-1.5 text-[12.5px] text-ink-0 outline-none focus:border-accent"
            value={audio}
            onChange={(e) => setAudio(e.target.value as 'best' | 'm4a' | 'opus')}
          >
            <option value="best">Best audio</option>
            <option value="m4a">MP4 (AAC)</option>
            <option value="opus">Opus (WebM)</option>
          </select>
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11.5px] text-ink-3">
          Folder
          <span className="flex gap-1.5">
            <input
              className="min-w-0 flex-1 rounded-lg border border-surface-4 bg-surface-2 px-2 py-1.5 text-[12.5px] text-ink-0 outline-none focus:border-accent"
              placeholder="Default downloads folder"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
            />
            <button
              className="shrink-0 rounded-lg border border-surface-4 bg-surface-2 px-2.5 py-1.5 text-[12px] text-ink-2 hover:text-ink-0"
              onClick={() => void pickVideoFolder().then((dir) => dir && setFolder(dir))}
            >
              Choose…
            </button>
          </span>
        </label>
        <span className="flex items-center gap-2">
          {isPlaylist && (
            <button
              className="flex items-center gap-1.5 rounded-lg border border-accent/60 bg-surface-2 px-3.5 py-2 text-[12.5px] font-semibold text-accent transition-opacity hover:bg-accent hover:text-white disabled:opacity-50"
              disabled={busy}
              onClick={() => void playPlaylist()}
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} className="ml-0.5 fill-current" />}
              Play
            </button>
          )}
          <button
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[12.5px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            disabled={busy}
            onClick={() => void start()}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <DownloadIcon size={13} />}
            Download
          </button>
          {onClose && (
            <button
              className="rounded-lg border border-surface-4 bg-surface-2 px-3 py-2 text-[12.5px] text-ink-2 hover:text-ink-0"
              onClick={onClose}
            >
              Cancel
            </button>
          )}
          {status && <span className="text-[12px] text-accent">{status}</span>}
        </span>
      </div>
    </div>
  )
}