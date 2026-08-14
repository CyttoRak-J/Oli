import { useCallback, useEffect, useState } from 'react'
import { History as HistoryIcon, Play, Trash2, ListChecks, SkipForward } from 'lucide-react'
import { getHistory, clearHistory, resolveYouTubeStream } from '../lib/ipc'
import type { PlaybackHistoryEntry } from '@shared/types'
import { usePlayer } from '../store/player'
import { useShallow } from 'zustand/react/shallow'
import { Artwork } from '../components/Artwork'
import { EmptyState } from '../components/EmptyState'
import { formatDuration, relativeTime } from '../lib/format'
import { cn } from '../components/cn'
import { ListJumpButtons } from '../components/ListJumpButtons'

export function History(): React.JSX.Element {
  const player = usePlayer(
    useShallow((s) => ({
      current: s.current,
      status: s.status,
      playNext: s.playNext,
      playTracks: s.playTracks
    }))
  )
  const [items, setItems] = useState<PlaybackHistoryEntry[]>([])
  const [resolvingId, setResolvingId] = useState<string | null>(null)

  const playTrackEntry = (entry: PlaybackHistoryEntry): void => {
    const track = entry.track
    if (!track) return
    if (track.path) {
      player.playTracks([track], 0, { source: 'library', sourceId: null })
      return
    }
    // Online entries (YouTube) are replayable: resolve a fresh stream URL.
    const videoId = track.id.startsWith('youtube:') ? track.id.slice('youtube:'.length) : ''
    if (!videoId) return
    setResolvingId(entry.id)
    void resolveYouTubeStream(videoId)
      .then((urls) => {
        if (urls.length === 0) return
        player.playTracks(
          [{ ...track, missing: false, streamUrl: urls[0], streamUrls: urls }],
          0,
          { source: 'search', sourceId: null }
        )
      })
      .finally(() => setResolvingId(null))
  }

  const nextTrackEntry = (entry: PlaybackHistoryEntry): void => {
    const track = entry.track
    if (!track) return
    if (track.path) {
      player.playNext(track)
      return
    }
    // Online entries (YouTube) are replayable: resolve a fresh stream URL.
    const videoId = track.id.startsWith('youtube:') ? track.id.slice('youtube:'.length) : ''
    if (!videoId) return
    setResolvingId(entry.id)
    void resolveYouTubeStream(videoId)
      .then((urls) => {
        if (urls.length === 0) return
        player.playNext({ ...track, missing: false, streamUrl: urls[0], streamUrls: urls })
      })
      .finally(() => setResolvingId(null))
  }

  const load = useCallback(() => {
    void getHistory(200)
      .then((h) => setItems(h))
      .catch(() => {})
  }, [])

  useEffect(() => {
    load()
    const iv = setInterval(load, 5000)
    return () => clearInterval(iv)
  }, [load])

  const currentId = player.current?.id
  useEffect(() => {
    if (!currentId) return
    const t = setTimeout(load, 600)
    return () => clearTimeout(t)
  }, [currentId, load])

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="sticky top-0 z-20 mb-4 flex items-center justify-between gap-3 bg-surface-1/85 px-2 py-2 backdrop-blur-sm">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-ink-0">
          <HistoryIcon size={22} /> History
          <span className="text-[12px] font-normal text-ink-3">{items.length} plays</span>
        </h1>
        <div className="flex items-center gap-2">
          <ListJumpButtons ids={items.map((e) => e.track?.id ?? '').filter(Boolean)} />
          {items.length > 0 && (
            <button
              className="flex items-center gap-1.5 rounded-lg border border-surface-4 bg-surface-2 px-3 py-1.5 text-[12px] text-ink-2 hover:border-red-400/60 hover:text-red-300"
              onClick={() => void clearHistory().then(load)}
            >
              <Trash2 size={13} /> Clear history
            </button>
          )}
        </div>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={<ListChecks size={36} className="mx-auto" />}
          title="No playback history"
          description="Songs you play will show up here."
        />
      ) : (
        <div className="flex flex-col">
          {items.map((entry) => {
            const track = entry.track
            if (!track) return null
            const isCurrent =
              player.current?.id === track.id && player.status !== 'idle'
            const isOnline = !track.path
            const canReplay = !isOnline || track.id.startsWith('youtube:')
            const playable = canReplay && resolvingId !== entry.id
            return (
              <div
                key={entry.id}
                data-track-id={track.id}
                className={cn(
                  'group flex items-center gap-2 rounded-lg px-2 py-1.5',
                  isCurrent ? 'bg-surface-2' : 'hover:bg-surface-1'
                )}
                onDoubleClick={() => {
                  if (playable) playTrackEntry(entry)
                }}
              >
                <button
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-surface-4 bg-surface-2 text-ink-2 opacity-0 transition-opacity group-hover:border-accent group-hover:opacity-100 disabled:opacity-30"
                  onClick={() => playTrackEntry(entry)}
                  disabled={!playable}
                  aria-label={resolvingId === entry.id ? 'Loading…' : isOnline ? `Play ${track.title}` : 'Play'}
                  title={
                    !canReplay
                      ? 'Played from an online provider; no stream available'
                      : resolvingId === entry.id
                        ? 'Resolving stream…'
                        : undefined
                  }
                >
                  {resolvingId === entry.id ? (
                    <span className="ml-0.5 h-2 w-2 animate-pulse rounded-full bg-accent" />
                  ) : (
                    <Play size={13} className="ml-0.5 fill-current" />
                  )}
                </button>
                <button
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-surface-4 bg-surface-2 text-ink-2 opacity-0 transition-opacity group-hover:border-accent group-hover:opacity-100 disabled:opacity-30"
                  onClick={() => nextTrackEntry(entry)}
                  disabled={!playable}
                  aria-label={`Play ${track.title} next`}
                  title="Play next"
                >
                  <SkipForward size={13} />
                </button>
                <Artwork
                  songId={track.id}
                  hasEmbedded={track.hasEmbeddedArtwork}
                  artworkUrl={track.artworkUrl}
                  label={track.title}
                  size={32}
                />
                <div className="min-w-0 flex-1">
                  <button
                    className={cn(
                      'block w-full min-w-0 truncate text-left text-[13px] font-medium leading-snug',
                      isCurrent ? 'text-accent' : 'text-ink-0 hover:text-accent'
                    )}
                    onClick={() => playTrackEntry(entry)}
                    title="Play song"
                  >
                    {track.title}
                  </button>
                  <div className="truncate text-[11.5px] text-ink-2">
                    {track.artist}
                    {track.album ? ` · ${track.album}` : ''}
                  </div>
                </div>
                <span className="hidden items-center gap-2 text-[11px] text-ink-3 sm:flex">
                  {entry.completed ? null : <span>played {formatDuration(entry.durationSeconds)}</span>}
                  <span className="tabular-nums">{relativeTime(entry.playedAt)}</span>
                </span>
                <span className="sm:hidden tabular-nums text-[11px] text-ink-3">
                  {relativeTime(entry.playedAt)}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
