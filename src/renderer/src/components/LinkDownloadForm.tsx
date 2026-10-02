import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download as DownloadIcon, Loader2, Play } from 'lucide-react'
import {
  enqueueEntries,
  pickVideoFolder,
  videoDownload,
  videoDownloadSong,
  resolvePlaylistEntries
} from '../lib/ipc'
import { onlineToTrack } from '../lib/onlineTracks'
import { formatDuration } from '../lib/format'
import { usePlayer } from '../store/player'
import { cn } from './cn'
import type { DetectedLink } from '../lib/linkDetect'

const VIDEO_QUALITIES = [0, 2160, 1440, 1080, 720, 480, 360]

/** Auto-generated YouTube Mixes are the natural thing to want as a whole. */
function looksLikeMix(url: string): boolean {
  return /[?&]list=RD(?!CLAK)/.test(url) || /[?&]start_radio=/.test(url)
}

/**
 * Download form for a pasted YouTube/Spotify link. For a watch URL that also
 * carries a playlist (radio mixes etc.) the user picks between "this video"
 * and "the whole playlist". A playlist is resolved as soon as it is chosen,
 * listed with checkboxes, and can be played or downloaded as tagged audio
 * or as video files.
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
  const [scope, setScope] = useState<'video' | 'playlist'>(() =>
    link.kind === 'both' ? (looksLikeMix(link.playlistUrl) ? 'playlist' : 'video') : link.kind
  )
  const [format, setFormat] = useState<'song' | 'video'>('song')
  const [quality, setQuality] = useState(0)
  const [audio, setAudio] = useState<'best' | 'm4a' | 'opus'>('best')
  const [folder, setFolder] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  /** Videos the user un-ticked (everything is selected by default). */
  const [excluded, setExcluded] = useState<Set<string>>(new Set())

  const isPlaylist = scope === 'playlist'
  const videoId = link.kind === 'video' || link.kind === 'both' ? link.videoId : null
  const playlistUrl = link.kind === 'playlist' || link.kind === 'both' ? link.playlistUrl : null
  const shownUrl = link.kind === 'both' ? (isPlaylist ? playlistUrl : videoId) : videoId ?? playlistUrl

  // Resolve right away (not on the first button press): the list is what the
  // user wants to see, and it is cached in main for Play / Download.
  const resolved = useQuery({
    queryKey: ['link-playlist', playlistUrl],
    queryFn: () => resolvePlaylistEntries(playlistUrl as string),
    enabled: isPlaylist && Boolean(playlistUrl),
    staleTime: 10 * 60_000,
    retry: false
  })
  const entries = useMemo(() => resolved.data?.entries ?? [], [resolved.data])
  const selected = useMemo(() => entries.filter((e) => !excluded.has(e.videoId)), [entries, excluded])
  const noun = format === 'video' ? 'video' : 'song'

  const toggle = (id: string): void =>
    setExcluded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const playSelected = (): void => {
    if (selected.length === 0) return
    // No stream URLs are resolved up front: the player resolves the song it
    // is about to play by itself and the next ones are prefetched, so
    // playback starts as soon as the first stream is ready.
    const tracks = selected.map((entry) =>
      onlineToTrack(
        {
          provider: 'youtube',
          id: `youtube:${entry.videoId}`,
          title: entry.title,
          artist: entry.channel ?? entry.track?.artists?.join(', ') ?? 'YouTube',
          album: entry.track?.album ?? resolved.data?.title ?? null,
          duration: entry.duration ?? null,
          year: null,
          artworkUrl: entry.thumbnail ?? null,
          url: `https://www.youtube.com/watch?v=${entry.videoId}`,
          previewUrl: null,
          videoId: entry.videoId
        },
        []
      )
    )
    usePlayer.getState().playTracks(tracks, 0, { source: 'search', sourceId: null })
    setStatus(`Playing ${tracks.length} ${tracks.length === 1 ? 'song' : 'songs'}`)
    setTimeout(() => setStatus(''), 4000)
  }

  const playVideo = async (): Promise<void> => {
    if (!videoId) return
    // Title and channel come from YouTube's public oEmbed endpoint; if it is
    // unreachable the player still plays the video under a generic title.
    let title = 'YouTube video'
    let channel = 'YouTube'
    try {
      const r = await fetch(
        `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`
      )
      if (r.ok) {
        const j = (await r.json()) as { title?: string; author_name?: string }
        if (j.title) title = j.title
        if (j.author_name) channel = j.author_name
      }
    } catch {
      /* keep the generic title */
    }
    const track = onlineToTrack(
      {
        provider: 'youtube',
        id: `youtube:${videoId}`,
        title,
        artist: channel,
        album: null,
        duration: null,
        year: null,
        artworkUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        previewUrl: null,
        videoId
      },
      []
    )
    usePlayer.getState().playTracks([track], 0, { source: 'search', sourceId: null })
    setStatus('Playing')
    setTimeout(() => setStatus(''), 4000)
  }

  const start = async (): Promise<void> => {
    setBusy(true)
    setStatus('Starting…')
    try {
      const dest = folder.trim() || null
      if (isPlaylist && playlistUrl) {
        if (selected.length === 0) {
          setStatus('Nothing selected')
          return
        }
        const res = await enqueueEntries(
          selected.map((e) => ({ videoId: e.videoId, title: e.title, duration: e.duration, track: e.track })),
          { mode: format, audio, height: quality, destDir: dest }
        )
        setStatus(
          res.enqueued > 0
            ? `Added ${res.enqueued} of ${res.found} ${noun}s. Downloads started, see the Downloads page.`
            : 'Those are already in the downloads list'
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

  const selectCls =
    'rounded-lg border border-surface-4 bg-surface-2 px-2 py-1.5 text-[12.5px] text-ink-0 outline-none focus:border-accent'

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-accent/30 bg-surface-1 p-3">
      <div className="text-[13px] font-medium text-ink-0">
        {isPlaylist
          ? resolved.data?.title
            ? `Playlist: ${resolved.data.title}`
            : 'Playlist download'
          : 'YouTube download options'}
        <span className="ml-2 block truncate rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-3">
          {shownUrl}
        </span>
      </div>

      {link.kind === 'both' && (
        <label className="flex w-fit flex-col gap-1 text-[11.5px] text-ink-3">
          What to use
          <select
            className={selectCls}
            value={scope}
            onChange={(e) => setScope(e.target.value as 'video' | 'playlist')}
          >
            <option value="video">This video only</option>
            <option value="playlist">Entire playlist</option>
          </select>
        </label>
      )}

      {isPlaylist && resolved.isLoading && (
        <div className="flex items-center gap-2 py-3 text-[12.5px] text-ink-3">
          <Loader2 size={14} className="animate-spin" />
          Resolving playlist… this can take a few seconds
        </div>
      )}
      {isPlaylist && !resolved.isLoading && (resolved.isError || resolved.data?.error) && (
        <div className="rounded-lg border border-red-400/30 bg-red-500/5 px-3 py-2 text-[12.5px] text-red-300">
          {resolved.data?.error ?? 'Could not read this playlist.'}
          <button className="ml-2 underline hover:text-red-200" onClick={() => void resolved.refetch()}>
            Try again
          </button>
        </div>
      )}
      {isPlaylist && entries.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-2">
            <span>
              {entries.length} {entries.length === 1 ? 'video' : 'videos'}
              {resolved.data?.capped
                ? resolved.data?.mix
                  ? ' (a Mix never ends: showing the first ones)'
                  : ' (playlist limited to the first ones)'
                : ''}
            </span>
            <span className="text-ink-3">{selected.length} selected</span>
            <button className="text-accent hover:underline" onClick={() => setExcluded(new Set())}>
              Select all
            </button>
            <button
              className="text-accent hover:underline"
              onClick={() => setExcluded(new Set(entries.map((e) => e.videoId)))}
            >
              Select none
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto rounded-lg border border-surface-4 bg-surface-0">
            {entries.map((e) => {
              const on = !excluded.has(e.videoId)
              return (
                <label
                  key={e.videoId}
                  className={cn(
                    'flex cursor-pointer items-center gap-2.5 px-2.5 py-1.5 hover:bg-surface-2',
                    !on && 'opacity-50'
                  )}
                >
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 shrink-0 accent-accent"
                    checked={on}
                    onChange={() => toggle(e.videoId)}
                  />
                  {e.thumbnail ? (
                    <img
                      src={e.thumbnail}
                      alt=""
                      loading="lazy"
                      className="h-7 w-12 shrink-0 rounded bg-surface-3 object-cover"
                    />
                  ) : null}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] text-ink-0">{e.title}</span>
                    {e.channel && <span className="block truncate text-[11px] text-ink-3">{e.channel}</span>}
                  </span>
                  {e.duration != null && (
                    <span className="shrink-0 text-[11px] tabular-nums text-ink-3">
                      {formatDuration(e.duration)}
                    </span>
                  )}
                </label>
              )
            })}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[11.5px] text-ink-3">
          {isPlaylist ? 'Download as' : 'Format'}
          <select
            className={selectCls}
            value={format}
            onChange={(e) => setFormat(e.target.value as 'song' | 'video')}
          >
            <option value="song">{isPlaylist ? 'Audio (tagged songs)' : 'Song (tagged audio)'}</option>
            <option value="video">{isPlaylist ? 'Video files' : 'Video'}</option>
          </select>
        </label>
        {format === 'video' && (
          <label className="flex flex-col gap-1 text-[11.5px] text-ink-3">
            Video quality
            <select className={selectCls} value={quality} onChange={(e) => setQuality(Number(e.target.value))}>
              {VIDEO_QUALITIES.map((q) => (
                <option key={q} value={q}>
                  {q === 0 ? 'Best' : `${q}p`}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1 text-[11.5px] text-ink-3">
          Audio
          <select
            className={selectCls}
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
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(isPlaylist || videoId) && (
          <button
            className="flex items-center gap-1.5 rounded-lg border border-accent/60 bg-surface-2 px-3.5 py-2 text-[12.5px] font-semibold text-accent transition-opacity hover:bg-accent hover:text-white disabled:opacity-50"
            disabled={busy || (isPlaylist && selected.length === 0)}
            onClick={isPlaylist ? playSelected : () => void playVideo()}
          >
            <Play size={13} className="ml-0.5 fill-current" />
            Play{isPlaylist && selected.length > 0 && entries.length > 0 ? ` ${selected.length}` : ''}
          </button>
        )}
        <button
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[12.5px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          disabled={busy || (isPlaylist && selected.length === 0)}
          onClick={() => void start()}
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <DownloadIcon size={13} />}
          {isPlaylist
            ? selected.length > 0
              ? `Download ${selected.length} ${noun}${selected.length === 1 ? '' : 's'}`
              : 'Download'
            : 'Download'}
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
      </div>
    </div>
  )
}
