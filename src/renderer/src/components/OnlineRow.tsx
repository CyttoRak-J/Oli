import { useEffect, useRef, useState } from 'react'
import { Download, FolderOpen, ListPlus, Loader2, MonitorPlay, Music2, Play, SkipForward } from 'lucide-react'
import type { OnlineSearchResult } from '@shared/types'
import {
  openVideoWindow,
  pickVideoFolder,
  resolveYouTubeStream,
  videoDownload,
  videoDownloadSong
} from '../lib/ipc'
import { onlineToTrack } from '../lib/onlineTracks'
import { usePlayer } from '../store/player'
import { useTrackInfo } from '../lib/useTrackInfo'
import { formatDuration } from '../lib/format'
import { cn } from './cn'

export type OnlineRowVariant = 'home' | 'search'

/** One online search result row. 'home' shows compact icon actions + the
 *  download popover; 'search' shows labelled buttons. */
export function OnlineRow({
  result,
  variant = 'search'
}: {
  result: OnlineSearchResult
  variant?: OnlineRowVariant
}): React.JSX.Element {
  const [resolving, setResolving] = useState(false)
  const [queuing, setQueuing] = useState(false)
  const [dlMode, setDlMode] = useState<'song' | 'video' | null>(null)
  const [dlQuality, setDlQuality] = useState(0)
  const [dlAudio, setDlAudio] = useState<'best' | 'm4a' | 'opus'>('best')
  const [dlFolder, setDlFolder] = useState('')
  const [dlBusy, setDlBusy] = useState(false)
  const [dlStatus, setDlStatus] = useState('')
  const openInfo = useTrackInfo()

  const resolve = (): Promise<string[]> => {
    if (!result.videoId) return Promise.resolve([])
    return resolveYouTubeStream(result.videoId)
  }

  const playOnline = (): void => {
    setResolving(true)
    void resolve().then((urls) => {
      setResolving(false)
      if (urls.length > 0) {
        usePlayer.getState().playTrack(onlineToTrack(result, urls), { source: 'search', sourceId: null })
      } else {
        window.open(result.url, '_blank')
      }
    })
  }

  const playByName = (): void => {
    if (result.localMatch) {
      openInfo(result.localMatch)
      return
    }
    if (!result.videoId) return
    setResolving(true)
    void resolve().then((urls) => {
      setResolving(false)
      if (urls.length > 0) {
        usePlayer.getState().playTrack(onlineToTrack(result, urls), { source: 'search', sourceId: null })
      }
    })
  }

  const queueOnline = (): void => {
    setQueuing(true)
    void resolve().then((urls) => {
      setQueuing(false)
      if (urls.length > 0) {
        usePlayer.getState().addToQueue(onlineToTrack(result, urls))
      }
    })
  }

  const nextOnline = (): void => {
    setQueuing(true)
    void resolve().then((urls) => {
      setQueuing(false)
      if (urls.length > 0) {
        usePlayer.getState().playNext(onlineToTrack(result, urls))
      }
    })
  }

  const openDownload = (mode: 'song' | 'video'): void => {
    setDlMode(mode)
    setDlQuality(0)
    setDlAudio('best')
    setDlFolder('')
    setDlStatus('')
  }

  const startDownload = async (): Promise<void> => {
    if (!dlMode || !result.videoId) return
    setDlBusy(true)
    setDlStatus('Starting…')
    try {
      const folder = dlFolder.trim() || null
      const id =
        dlMode === 'song'
          ? await videoDownloadSong(result.videoId, dlAudio, folder)
          : await videoDownload(result.videoId, dlQuality, dlAudio, folder)
      if (id) setDlMode(null)
      setDlStatus(id ? 'Download started — see the Downloads page' : "Couldn't start")
    } catch {
      setDlStatus('Failed to start')
    }
    setDlBusy(false)
  }

  const isHome = variant === 'home'

  return (
    <div className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-surface-1">
      {result.artworkUrl ? (
        <img src={result.artworkUrl} alt="" className="h-9 w-10 shrink-0 rounded bg-surface-2 object-cover" />
      ) : (
        <div className="flex h-9 w-10 shrink-0 items-center justify-center rounded bg-surface-2 text-[10px] font-bold text-ink-3">
          {result.provider}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <button
          className="block w-full min-w-0 break-words text-left text-[13px] font-medium leading-snug text-ink-0 hover:text-accent"
          onClick={playByName}
          title="Play song"
        >
          {result.title}
        </button>
        <div className="truncate text-[11.5px] text-ink-2">
          {result.artist}
          {result.album ? ` · ${result.album}` : ''}
          <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase text-ink-3">
            {result.provider}
          </span>
        </div>
      </div>
      {result.duration != null && (
        <span className="text-[11.5px] tabular-nums text-ink-3">{formatDuration(result.duration)}</span>
      )}

      {result.localMatch ? (
        isHome ? (
          <button
            className="rounded-md border border-accent/60 bg-surface-2 px-2.5 py-1 text-[11.5px] font-medium text-accent hover:bg-accent hover:text-white"
            onClick={() => usePlayer.getState().playTrack(result.localMatch!, { source: 'search', sourceId: null })}
          >
            Play local
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <button
              className="rounded-md border border-accent/60 bg-surface-2 px-2.5 py-1 text-[11.5px] font-medium text-accent hover:bg-accent hover:text-white"
              onClick={() => usePlayer.getState().playTrack(result.localMatch!, { source: 'search', sourceId: null })}
            >
              Play local
            </button>
            <button
              className="rounded-md border border-surface-4 bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-2 hover:border-accent"
              onClick={() => usePlayer.getState().playNext(result.localMatch!)}
            >
              Play next
            </button>
          </div>
        )
      ) : result.videoId ? (
        isHome ? (
          <div className="flex items-center gap-1.5">
            <button
              disabled={resolving}
              title="Play in app"
              aria-label="Play in app"
              className="flex h-7 w-7 items-center justify-center rounded-md border border-accent/60 bg-surface-2 text-accent transition-colors hover:bg-accent hover:text-white disabled:opacity-60"
              onClick={playOnline}
            >
              {resolving ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} className="ml-0.5 fill-current" />}
            </button>
            <button
              title="Download song (audio)"
              aria-label="Download song (audio)"
              className="flex h-7 w-7 items-center justify-center rounded-md border border-accent/30 bg-surface-2 text-ink-2 transition-colors hover:border-accent hover:text-accent disabled:opacity-60"
              onClick={() => openDownload('song')}
            >
              <Music2 size={13} />
            </button>
            <button
              disabled={queuing}
              title="Add to queue"
              aria-label="Add to queue"
              className="flex h-7 w-7 items-center justify-center rounded-md border border-surface-4 bg-surface-2 text-ink-2 transition-colors hover:border-accent hover:text-ink-0 disabled:opacity-60"
              onClick={queueOnline}
            >
              {queuing ? <Loader2 size={13} className="animate-spin" /> : <ListPlus size={13} />}
            </button>
            <button
              disabled={queuing}
              title="Play next"
              aria-label="Play next"
              className="flex h-7 w-7 items-center justify-center rounded-md border border-surface-4 bg-surface-2 text-ink-2 transition-colors hover:border-accent hover:text-ink-0 disabled:opacity-60"
              onClick={nextOnline}
            >
              <SkipForward size={13} />
            </button>
            <button
              title="Open video window"
              aria-label="Open video window"
              className="flex h-7 w-7 items-center justify-center rounded-md border border-surface-4 bg-surface-2 text-ink-2 transition-colors hover:border-accent hover:text-ink-0"
              onClick={() => void openVideoWindow(result.videoId!)}
            >
              <MonitorPlay size={13} />
            </button>
            <button
              title="Download video"
              aria-label="Download video"
              className="flex h-7 w-7 items-center justify-center rounded-md border border-surface-4 bg-surface-2 text-ink-2 transition-colors hover:border-accent hover:text-ink-0 disabled:opacity-60"
              onClick={() => openDownload('video')}
            >
              <Download size={13} />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              disabled={resolving}
              className="rounded-md border border-accent/60 bg-surface-2 px-2.5 py-1 text-[11.5px] font-medium text-accent hover:bg-accent hover:text-white disabled:opacity-60"
              onClick={playOnline}
            >
              {resolving ? 'Loading…' : 'Play in app'}
            </button>
            <button
              disabled={queuing}
              className="rounded-md border border-surface-4 bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-2 hover:border-accent disabled:opacity-60"
              onClick={queueOnline}
            >
              {queuing ? 'Adding…' : 'Queue'}
            </button>
            <button
              disabled={queuing}
              className="rounded-md border border-surface-4 bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-2 hover:border-accent disabled:opacity-60"
              onClick={nextOnline}
            >
              {queuing ? 'Adding…' : 'Play next'}
            </button>
            <button
              className="flex items-center gap-1 rounded-md border border-surface-4 bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-2 hover:border-accent"
              onClick={() => void openVideoWindow(result.videoId!)}
            >
              <MonitorPlay size={12} />
              Video
            </button>
          </div>
        )
      ) : result.previewUrl ? (
        <PreviewButton url={result.previewUrl} />
      ) : (
        <button
          className="rounded-md border border-surface-4 bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-2 hover:border-accent"
          onClick={() => window.open(result.url, '_blank')}
        >
          Open external
        </button>
      )}

      {isHome && dlMode && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={(e) => {
            if (e.target === e.currentTarget && !dlBusy) setDlMode(null)
          }}
        >
          <div className="flex w-[min(380px,92vw)] flex-col gap-3 rounded-xl border border-edge bg-surface-1 p-4 shadow-2xl">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[13.5px] font-semibold text-ink-0">
                {dlMode === 'song' ? 'Download song (audio)' : 'Download video'}
              </h3>
              <span className="truncate font-mono text-[10.5px] text-ink-3">{result.videoId}</span>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              {dlMode === 'video' && (
                <label className="flex flex-col gap-1 text-[11.5px] text-ink-3">
                  Video quality
                  <select
                    className="rounded-lg border border-surface-4 bg-surface-2 px-2 py-1.5 text-[12.5px] text-ink-0 outline-none focus:border-accent"
                    value={dlQuality}
                    onChange={(e) => setDlQuality(Number(e.target.value))}
                  >
                    {[0, 2160, 1440, 1080, 720, 480, 360].map((q) => (
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
                  className="rounded-lg border border-surface-4 bg-surface-2 px-2 py-1.5 text-[12.5px] text-ink-0 outline-none focus:border-accent"
                  value={dlAudio}
                  onChange={(e) => setDlAudio(e.target.value as 'best' | 'm4a' | 'opus')}
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
                    value={dlFolder}
                    onChange={(e) => setDlFolder(e.target.value)}
                  />
                  <button
                    className="shrink-0 rounded-lg border border-surface-4 bg-surface-2 px-2.5 py-1.5 text-[12px] text-ink-2 hover:text-ink-0"
                    onClick={() => void pickVideoFolder().then((dir) => dir && setDlFolder(dir))}
                  >
                    <FolderOpen size={13} />
                  </button>
                </span>
              </label>
            </div>
            <div className="flex items-center gap-2">
              <button
                className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[12.5px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                disabled={dlBusy}
                onClick={() => void startDownload()}
              >
                {dlBusy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                Download
              </button>
              <button
                className="rounded-lg border border-surface-4 bg-surface-2 px-3 py-2 text-[12.5px] text-ink-2 hover:text-ink-0"
                disabled={dlBusy}
                onClick={() => setDlMode(null)}
              >
                Cancel
              </button>
              {dlStatus && <span className="text-[12px] text-accent">{dlStatus}</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function PreviewButton({ url }: { url: string }): React.JSX.Element {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)

  const toggle = (): void => {
    if (playing) {
      audioRef.current?.pause()
      audioRef.current = null
      setPlaying(false)
    } else {
      const el = new Audio(url)
      audioRef.current = el
      el.onended = () => {
        setPlaying(false)
        audioRef.current = null
      }
      void el.play()
      setPlaying(true)
    }
  }

  useEffect(() => {
    return () => {
      audioRef.current?.pause()
      audioRef.current = null
    }
  }, [])

  return (
    <button
      className={cn(
        'rounded-md border px-2.5 py-1 text-[11.5px]',
        playing
          ? 'border-accent bg-accent text-white'
          : 'border-surface-4 bg-surface-2 text-ink-2 hover:border-accent'
      )}
      onClick={toggle}
    >
      {playing ? 'Stop preview' : 'Preview'}
    </button>
  )
}
