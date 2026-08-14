import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Dialog from '@radix-ui/react-dialog'
import {
  Play,
  Pause,
  Heart,
  MoreHorizontal,
  ListPlus,
  SkipForward,
  FolderOpen,
  RefreshCw,
  Pencil,
  X,
  Loader2,
  Info,
  Shuffle
} from 'lucide-react'
import type { Track } from '@shared/types'
import { cn } from './cn'
import { Artwork } from './Artwork'
import { usePlayer, type PlaySource } from '../store/player'
import { useShallow } from 'zustand/react/shallow'
import { toggleFavorite, revealInExplorer, refreshMetadata, editMetadata } from '../lib/ipc'
import { invalidateFavorites } from '../lib/favorites'
import { formatDuration } from '../lib/format'
import { AddToPlaylistDialog } from './AddToPlaylistDialog'
import { ListJumpButtons } from './ListJumpButtons'
import { useIncrementalRender } from '../lib/useIncrementalRender'

const MENU_ITEM_CLS =
  'flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 text-left text-[12.5px] text-ink-1 outline-none hover:bg-surface-3'
const MENU_CLS = 'z-50 min-w-[190px] rounded-lg border border-edge bg-surface-2 p-1 shadow-2xl'

export interface SongTableProps {
  tracks: Track[]
  source: PlaySource
  showAlbum?: boolean
  showArtist?: boolean
  /** Optional refresh action shown next to the track count (e.g. reshuffle random picks). */
  onRefresh?: () => void
  /** Optional shuffle button next to play-all: queues every track in random order. */
  onShuffleAll?: () => void
  /** Enable checkboxes for multi-select (e.g. bulk metadata fix). */
  selectable?: boolean
  selected?: Set<string>
  onToggleSelect?: (id: string) => void
}

export function SongTable({
  tracks,
  source,
  showAlbum = true,
  showArtist = true,
  onRefresh,
  onShuffleAll,
  selectable = false,
  selected,
  onToggleSelect
}: SongTableProps): React.JSX.Element {
  const player = usePlayer(
    useShallow((s) => ({
      current: s.current,
      status: s.status,
      pause: s.pause,
      play: s.play,
      playNext: s.playNext,
      playTracks: s.playTracks,
      patchTrack: s.patchTrack
    }))
  )
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const rows = tracks.filter((t) => !t.missing)
  const { visible, sentinelRef } = useIncrementalRender(rows.length, 200)
  const [addTarget, setAddTarget] = useState<Track | null>(null)
  const [editTarget, setEditTarget] = useState<Track | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; track: Track } | null>(null)
  const navTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Close the context menu on Escape / outside click / scroll / blur.
  useEffect(() => {
    if (!ctxMenu) return
    const close = (): void => setCtxMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    const onPointer = (e: MouseEvent): void => {
      if (!(e.target as HTMLElement).closest('[data-ctx-menu]')) close()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onPointer)
    window.addEventListener('blur', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onPointer)
      window.removeEventListener('blur', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [ctxMenu])

  const playAt = (index: number): void => {
    player.playTracks(rows, index, source)
  }

  const columns = [
    ...(selectable ? ['28px'] : []),
    '36px',
    'minmax(0,1fr)',
    ...(showArtist ? ['120px'] : []),
    ...(showAlbum ? ['120px'] : []),
    '48px',
    '110px'
  ].join(' ')

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-20 flex h-14 items-center gap-4 border-b border-edge bg-surface-0 px-4">
        <button
          className="flex h-11 w-11 items-center justify-center rounded-full bg-accent text-white shadow-lg transition-transform hover:scale-105 disabled:opacity-40"
          disabled={rows.length === 0}
          onClick={() => playAt(0)}
          aria-label="Play all"
        >
          <Play size={18} className="ml-0.5 fill-current" />
        </button>
        {onShuffleAll && (
          <button
            className="flex h-11 w-11 items-center justify-center rounded-full border border-surface-4 bg-surface-2 text-ink-2 shadow-lg transition-transform hover:border-accent hover:text-accent hover:scale-105 disabled:opacity-40"
            disabled={rows.length === 0}
            onClick={onShuffleAll}
            aria-label="Shuffle and play all"
            title="Play every track in random order"
          >
            <Shuffle size={17} />
          </button>
        )}
        {onRefresh && (
          <button
            className="flex items-center gap-1 rounded-md border border-surface-4 bg-surface-2 px-2 py-1 text-[11.5px] text-ink-2 transition-colors hover:border-accent hover:text-ink-0"
            onClick={onRefresh}
            title="Shuffle new picks"
            aria-label="Shuffle new picks"
          >
            <RefreshCw size={12} />
            Refresh
          </button>
        )}
        <span className="text-[12px] text-ink-3">{rows.length} tracks</span>
      </div>

      <div
        className="grid items-center gap-2 border-b border-edge px-4 pb-2 text-[10px] font-bold uppercase tracking-widest text-ink-3"
        style={{ gridTemplateColumns: columns }}
      >
        {selectable && onToggleSelect && (
          <div className="flex items-center justify-center">
            <input
              type="checkbox"
              checked={rows.length > 0 && (selected?.size ?? 0) === rows.length}
              onChange={() => {
                const all = (selected?.size ?? 0) === rows.length
                for (const t of rows) {
                  if (all ? selected?.has(t.id) : !selected?.has(t.id)) onToggleSelect(t.id)
                }
              }}
              ref={(el) => {
                if (!el) return
                el.indeterminate = (selected?.size ?? 0) > 0 && (selected?.size ?? 0) < rows.length
              }}
              className="h-3.5 w-3.5 cursor-pointer accent-accent"
              aria-label="Select all tracks"
            />
          </div>
        )}
        <span>#</span>
        <span>Title</span>
        {showArtist && <span>Artist</span>}
        {showAlbum && <span>Album</span>}
        <span className="text-center">♥</span>
        <span className="text-right">Time</span>
      </div>

      <div className="flex flex-col">
        {rows.length === 0 && (
          <div className="px-4 py-10 text-center text-[13px] text-ink-3">No tracks found.</div>
        )}
        {rows.map((track, index) => {
          if (index >= visible) return null
          const active = player.current?.id === track.id && player.status !== 'idle'
          const onToggleFav = (): void => {
            void toggleFavorite('song', track.id).then((fav) => {
              player.patchTrack(track.id, { favorite: fav })
              invalidateFavorites(queryClient)
            })
          }
          return (
            <div
              key={track.id}
              data-track-id={track.id}
              className={cn(
                'group grid items-center gap-2 px-4 py-1.5 transition-colors',
                active ? 'bg-surface-2' : 'hover:bg-surface-1'
              )}
              style={{ gridTemplateColumns: columns }}
              onDoubleClick={() => {
                if (navTimerRef.current) {
                  clearTimeout(navTimerRef.current)
                  navTimerRef.current = null
                }
                playAt(index)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                setCtxMenu({ x: e.clientX, y: e.clientY, track })
              }}
            >
                  {selectable && onToggleSelect && (
                    <div className="flex items-center justify-center">
                      <input
                        type="checkbox"
                        checked={selected?.has(track.id) ?? false}
                        onChange={() => onToggleSelect(track.id)}
                        className="h-3.5 w-3.5 cursor-pointer accent-accent"
                        aria-label={`Select ${track.title}`}
                      />
                    </div>
                  )}
                  <div className="relative flex items-center justify-center">
                    <span className={cn('text-[12px] tabular-nums text-ink-3', active && 'hidden')}>
                      {index + 1}
                    </span>
                    <button
                      className={cn('absolute hidden text-ink-0 group-hover:block', active && 'block')}
                      onClick={() => {
                        if (active && player.status === 'playing') player.pause()
                        else if (active) player.play()
                        else playAt(index)
                      }}
                      aria-label={active ? 'Pause' : 'Play'}
                    >
                      {active && player.status === 'playing' ? (
                        <Pause size={14} className="fill-current" />
                      ) : (
                        <Play size={14} className="ml-0.5 fill-current" />
                      )}
                    </button>
                  </div>

                  <div className="flex min-w-0 items-center gap-2.5">
                    <Artwork songId={track.id} hasEmbedded={track.hasEmbeddedArtwork} size={32} />
                    <button
                      className={cn(
                        'min-w-0 truncate text-left text-[13px] font-medium leading-snug',
                        active ? 'text-accent' : 'text-ink-0 hover:text-accent'
                      )}
                      onClick={() => {
                        if (navTimerRef.current) clearTimeout(navTimerRef.current)
                        navTimerRef.current = setTimeout(() => navigate(`/song/${track.id}`), 250)
                      }}
                      title="View song info"
                    >
                      {track.title}
                    </button>
                  </div>

                  {showArtist && (
                    <button
                      className="truncate text-left text-[12px] text-ink-2 hover:text-ink-0"
                      onClick={() => track.artistId && navigate(`/artists/${track.artistId}`)}
                    >
                      {track.artist}
                    </button>
                  )}
                  {showAlbum && (
                    <button
                      className="truncate text-left text-[12px] text-ink-2 hover:text-ink-0"
                      onClick={() => track.albumId && navigate(`/albums/${track.albumId}`)}
                    >
                      {track.album}
                    </button>
                  )}

                  <button
                    className="justify-self-center text-ink-3 transition-colors hover:text-accent"
                    onClick={onToggleFav}
                    aria-label="Toggle favorite"
                  >
                    <Heart size={14} className={cn(track.favorite && 'fill-accent text-accent')} />
                  </button>

                  <div className="flex items-center justify-end gap-2">
                    {track.format && (
                      <span
                        className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-3"
                        title={`Format: ${track.format}`}
                      >
                        {track.format}
                      </span>
                    )}
                    <span className="text-[12px] tabular-nums text-ink-3">
                      {formatDuration(track.duration)}
                    </span>
                    <RowMenu
                      track={track}
                      onAdd={() => setAddTarget(track)}
                      onEdit={() => setEditTarget(track)}
                    />
                  </div>
                </div>
          )
        })}
      </div>

      {rows.length > visible && <div ref={sentinelRef} className="h-10" />}

      {ctxMenu && (
        <div
          data-ctx-menu
          className={cn(MENU_CLS, 'fixed flex flex-col')}
          style={{
            left: Math.min(ctxMenu.x, window.innerWidth - 200),
            top: Math.min(ctxMenu.y, window.innerHeight - 190)
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <TrackMenuItems
            track={ctxMenu.track}
            onAdd={() => setAddTarget(ctxMenu.track)}
            onEdit={() => setEditTarget(ctxMenu.track)}
            close={() => setCtxMenu(null)}
          />
        </div>
      )}

      {addTarget && (
        <AddToPlaylistDialog
          open
          onOpenChange={(o) => {
            if (!o) setAddTarget(null)
          }}
          tracks={[addTarget]}
        />
      )}
      {editTarget && (
        <MetadataDialog
          open
          onOpenChange={(o) => {
            if (!o) setEditTarget(null)
          }}
          track={editTarget}
        />
      )}

      <div className="pointer-events-none sticky bottom-3 z-30 flex justify-end px-4">
        <div className="pointer-events-auto">
          <ListJumpButtons ids={rows.map((t) => t.id)} />
        </div>
      </div>
    </div>
  )
}

function RowMenu({
  track,
  onAdd,
  onEdit
}: {
  track: Track
  onAdd: () => void
  onEdit: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          className="text-ink-3 opacity-0 transition-opacity hover:text-ink-0 group-hover:opacity-100"
          aria-label="Track menu"
        >
          <MoreHorizontal size={16} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={MENU_CLS} sideOffset={4} align="end">
          <TrackMenuItems track={track} onAdd={onAdd} onEdit={onEdit} close={() => setOpen(false)} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function TrackMenuItems({
  track,
  onAdd,
  onEdit,
  close
}: {
  track: Track
  onAdd: () => void
  onEdit: () => void
  close: () => void
}): React.JSX.Element {
  const player = usePlayer(useShallow((s) => ({ playNext: s.playNext, patchTrack: s.patchTrack })))
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const item = (action: () => void): (() => void) => () => {
    action()
    close()
  }
  return (
    <>
      <button className={MENU_ITEM_CLS} onClick={item(() => navigate(`/song/${track.id}`))}>
        <Info size={14} /> Song info
      </button>
      <button className={MENU_ITEM_CLS} onClick={item(onAdd)}>
        <ListPlus size={14} /> Add to playlist
      </button>
      <button className={MENU_ITEM_CLS} onClick={item(() => player.playNext(track))}>
        <SkipForward size={14} /> Play next
      </button>
      <button className={MENU_ITEM_CLS} onClick={item(onEdit)}>
        <Pencil size={14} /> Edit metadata
      </button>
      <button className={MENU_ITEM_CLS} onClick={item(() => void revealInExplorer(track.path))}>
        <FolderOpen size={14} /> Reveal in Explorer
      </button>
      <button className={MENU_ITEM_CLS} onClick={item(() => void refreshMetadata(track.id))}>
        <RefreshCw size={14} /> Refresh metadata
      </button>
      <button
        className={MENU_ITEM_CLS}
        onClick={item(() =>
          void toggleFavorite('song', track.id).then((fav) => {
            player.patchTrack(track.id, { favorite: fav })
            invalidateFavorites(queryClient)
          })
        )}
      >
        <Heart size={14} className={cn(track.favorite && 'fill-accent text-accent')} />
        {track.favorite ? 'Remove from favorites' : 'Add to favorites'}
      </button>
    </>
  )
}

function MetadataDialog({
  open,
  onOpenChange,
  track
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  track: Track
}): React.JSX.Element {
  const [form, setForm] = useState(() => toForm(track))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const save = async (): Promise<void> => {
    setBusy(true)
    const edits: Record<string, unknown> = {
      title: form.title,
      artist: form.artist,
      albumArtist: form.albumArtist,
      album: form.album,
      genre: form.genre || null,
      composer: form.composer || null,
      year: form.year ? Number(form.year) : null,
      trackNo: form.trackNo ? Number(form.trackNo) : null,
      lyrics: form.lyrics || null
    }
    const ok = await editMetadata(track.id, edits).catch(() => false)
    setBusy(false)
    if (ok) {
      setMsg('Saved')
      setTimeout(() => onOpenChange(false), 500)
    } else {
      setMsg('Failed to save')
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,540px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-edge bg-surface-2 p-4 shadow-2xl outline-none">
          <div className="mb-3 flex items-center justify-between">
            <Dialog.Title className="text-[15px] font-semibold text-ink-0">
              Edit metadata
            </Dialog.Title>
            <Dialog.Close asChild>
              <button className="text-ink-3 hover:text-ink-0" aria-label="Close">
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Title" value={form.title} onChange={(v) => setForm({ ...form, title: v })} />
            <Field label="Artist" value={form.artist} onChange={(v) => setForm({ ...form, artist: v })} />
            <Field label="Album artist" value={form.albumArtist} onChange={(v) => setForm({ ...form, albumArtist: v })} />
            <Field label="Album" value={form.album} onChange={(v) => setForm({ ...form, album: v })} />
            <Field label="Genre" value={form.genre} onChange={(v) => setForm({ ...form, genre: v })} />
            <Field label="Composer" value={form.composer} onChange={(v) => setForm({ ...form, composer: v })} />
            <Field label="Year" value={form.year} onChange={(v) => setForm({ ...form, year: v })} />
            <Field label="Track #" value={form.trackNo} onChange={(v) => setForm({ ...form, trackNo: v })} />
            <div className="col-span-2">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                Lyrics
              </span>
              <textarea
                rows={5}
                className="w-full resize-none rounded-lg border border-edge bg-surface-3 p-2 text-[12.5px] text-ink-1 outline-none focus:border-accent"
                value={form.lyrics}
                onChange={(e) => setForm({ ...form, lyrics: e.target.value })}
              />
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between">
            <div className="text-[12px] text-ink-2">{msg}</div>
            <button
              className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              disabled={busy}
              onClick={() => void save()}
            >
              {busy && <Loader2 size={14} className="animate-spin" />}
              Save
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function toForm(t: Track): Record<string, string> {
  return {
    title: t.title,
    artist: t.artist,
    albumArtist: t.albumArtist,
    album: t.album,
    genre: t.genre ?? '',
    composer: t.composer ?? '',
    year: t.year ? String(t.year) : '',
    trackNo: t.trackNo ? String(t.trackNo) : '',
    lyrics: t.lyrics ?? ''
  }
}

function Field({
  label,
  value,
  onChange
}: {
  label: string
  value: string
  onChange: (v: string) => void
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-ink-3">
        {label}
      </span>
      <input
        className="w-full rounded border border-surface-4 bg-surface-2 px-2.5 py-1.5 text-[12.5px] text-ink-0 outline-none focus:border-accent"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}