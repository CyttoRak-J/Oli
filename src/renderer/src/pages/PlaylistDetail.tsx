import { useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Play, Trash2, ArrowLeft, GripVertical } from 'lucide-react'
import type { PlaylistEntry } from '@shared/types'
import {
  getPlaylist,
  getPlaylistEntries,
  removeFromPlaylist,
  reorderPlaylist,
  togglePlaylistPin,
  deletePlaylist
} from '../lib/ipc'
import { usePlayer } from '../store/player'
import { useShallow } from 'zustand/react/shallow'
import { cn } from '../components/cn'
import { Artwork } from '../components/Artwork'
import { formatDuration } from '../lib/format'
import { EmptyState } from '../components/EmptyState'

export function PlaylistDetail(): React.JSX.Element {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const player = usePlayer(useShallow((s) => ({ current: s.current, status: s.status, playTracks: s.playTracks })))

  const playlist = useQuery({
    queryKey: ['playlist', id],
    queryFn: () => getPlaylist(id ?? ''),
    enabled: Boolean(id)
  })
  const entries = useQuery({
    queryKey: ['playlist-entries', id],
    queryFn: () => getPlaylistEntries(id ?? ''),
    enabled: Boolean(id)
  })

  const dragIndex = useRef<number | null>(null)

  const tracks = (entries.data ?? []).map((e) => e.track).filter(Boolean)

  const removeTrack = async (entry: PlaylistEntry): Promise<void> => {
    if (!id) return
    await removeFromPlaylist(id, [entry.songId])
    qc.invalidateQueries({ queryKey: ['playlist-entries', id] })
    qc.invalidateQueries({ queryKey: ['playlists'] })
  }

  const onDrop = async (target: number): Promise<void> => {
    const from = dragIndex.current
    dragIndex.current = null
    if (!id || from == null || from === target) return
    const arr = (entries.data ?? []).slice()
    const [moved] = arr.splice(from, 1)
    arr.splice(target, 0, moved)
    const ids = arr.map((e) => e.songId)
    await reorderPlaylist(id, ids)
    qc.invalidateQueries({ queryKey: ['playlist-entries', id] })
  }

  if (playlist.isLoading || !playlist.data) {
    return <div className="p-6 text-[13px] text-ink-3">Loading…</div>
  }

  const p = playlist.data

  return (
    <div className="p-6">
      <button
        className="mb-4 flex items-center gap-1.5 text-[12.5px] text-ink-3 hover:text-ink-0"
        onClick={() => navigate('/playlists')}
      >
        <ArrowLeft size={14} /> All playlists
      </button>

      <div className="mb-6 flex items-center gap-4">
        <div className="flex h-28 w-28 items-center justify-center rounded-2xl bg-gradient-to-br from-[#312e81] to-[#9d174d] text-3xl font-black text-ink-0/60">
          {p.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-3xl font-extrabold text-ink-0">{p.name}</h1>
          <div className="mt-1 text-[12.5px] text-ink-2">
            {p.trackCount} tracks{p.totalDuration ? ` · ${formatDuration(p.totalDuration)}` : ''}
          </div>
          {p.description && <p className="mt-1 text-[12.5px] text-ink-3">{p.description}</p>}
          <div className="mt-3 flex items-center gap-2">
            <button
              className="flex h-11 w-11 items-center justify-center rounded-full bg-accent text-white hover:scale-105 disabled:opacity-40"
              disabled={tracks.length === 0}
              onClick={() =>
                player.playTracks(tracks, 0, { source: 'playlist', sourceId: p.id })
              }
              aria-label="Play all"
            >
              <Play size={18} className="ml-0.5 fill-current" />
            </button>
            <button
              className="rounded-lg border border-surface-4 bg-surface-2 px-3 py-1.5 text-[12.5px] text-ink-2 hover:border-accent"
              onClick={() =>
                void togglePlaylistPin(p.id).then(() =>
                  qc.invalidateQueries({ queryKey: ['playlist', id] })
                )
              }
            >
              {p.pinned ? 'Unpin' : 'Pin'}
            </button>
            <button
              className="rounded-lg border border-surface-4 bg-surface-2 px-3 py-1.5 text-[12.5px] text-ink-2 hover:border-red-400"
              onClick={async () => {
                await deletePlaylist(p.id)
                navigate('/playlists')
              }}
            >
              Delete
            </button>
          </div>
        </div>
      </div>

      {tracks.length === 0 ? (
        <EmptyState title="Empty playlist" description="Add tracks from any list using the ⋯ menu." />
      ) : (
        <div className="flex flex-col">
          {(entries.data ?? []).map((entry, index) => {
            const active = player.current?.id === entry.songId && player.status !== 'idle'
            return (
              <div
                key={entry.id}
                className={cn(
                  'group flex items-center gap-3 border-b border-edge/60 px-3 py-2 transition-colors',
                  active ? 'bg-surface-2' : 'hover:bg-surface-1'
                )}
draggable
                onDragStart={() => {
                  dragIndex.current = index
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => void onDrop(index)}
                onDoubleClick={() =>
                  player.playTracks(tracks, index, { source: 'playlist', sourceId: p.id })
                }
              >
                <GripVertical size={14} className="shrink-0 cursor-grab text-ink-3" />
                <span className="w-5 text-center text-[12px] tabular-nums text-ink-3">
                  {index + 1}
                </span>
                <Artwork songId={entry.songId} hasEmbedded={entry.track.hasEmbeddedArtwork} size={32} />
                <div className="min-w-0 flex-1">
                  <div className={cn('break-words text-[13px] font-medium leading-snug', active ? 'text-accent' : 'text-ink-0')}>
                    {entry.track.title}
                  </div>
                  <div className="truncate text-[11.5px] text-ink-2">{entry.track.artist}</div>
                </div>
                <span className="text-[12px] tabular-nums text-ink-3">
                  {formatDuration(entry.track.duration)}
                </span>
                <button
                  className="text-ink-3 hover:text-red-400"
                  onClick={() => void removeTrack(entry)}
                  aria-label="Remove from playlist"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}