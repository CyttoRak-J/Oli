import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { X, Loader2, Heart, Check, Merge } from 'lucide-react'
import { getAlbums, getArtists, toggleFavorite, mergeAlbums, mergeArtists } from '../lib/ipc'
import { ThemedSelect } from './ThemedSelect'
import { Artwork, ArtworkFallback } from './Artwork'
import { ListJumpButtons } from './ListJumpButtons'
import { useIncrementalRender } from '../lib/useIncrementalRender'
import { Tip } from './Tip'
import { AlphabetFilter, letterKey } from './AlphabetFilter'
import { SearchBox } from './SearchBox'
import { usePlayer } from '../store/player'
import { useShallow } from 'zustand/react/shallow'
import { formatCount, formatDuration } from '../lib/format'
import { cn } from './cn'
import type { Album, Artist } from '@shared/types'

export const ALBUM_SORTS: Array<[string, string]> = [
  ['title', 'Title'],
  ['artist', 'Artist'],
  ['year', 'Year'],
  ['addedAt', 'Date added']
]

export const ARTIST_SORTS: Array<[string, string]> = [
  ['name', 'Name'],
  ['albumCount', 'Albums'],
  ['trackCount', 'Tracks']
]

export function AlbumGrid({
  search,
  onSearchChange,
  letter,
  onLetterChange,
  onSearch
}: {
  search: string
  onSearchChange: (v: string) => void
  letter: string | null
  onLetterChange: (v: string | null) => void
  onSearch?: (v: string) => void
}): React.JSX.Element {
  const qc = useQueryClient()
  const albums = useQuery({ queryKey: ['albums'], queryFn: getAlbums })
  const player = usePlayer(useShallow((s) => ({ current: s.current })))
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [merging, setMerging] = useState(false)
  const [sort, setSort] = useState('title')
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc')

  const term = search.trim().toLowerCase()
  const cmpKey = (a: Album): string | number => {
    if (sort === 'artist') return a.artist.toLowerCase()
    if (sort === 'year') return a.year ?? 0
    if (sort === 'addedAt') return a.addedAt ?? 0
    return a.title.toLowerCase()
  }
  const list = (albums.data ?? [])
    .filter((a) => a.trackCount > 0)
    .filter((a) => !term || a.title.toLowerCase().includes(term) || a.artist.toLowerCase().includes(term))
    .filter((a) => !letter || letterKey(a.title) === letter)
    .slice()
    .sort((a, b) => {
      const ka = cmpKey(a)
      const kb = cmpKey(b)
      const cmp =
        typeof ka === 'number' && typeof kb === 'number'
          ? ka - kb
          : String(ka).localeCompare(String(kb))
      return direction === 'asc' ? cmp : -cmp
    })

  const { visible, sentinelRef } = useIncrementalRender(list.length, 120)

  if (albums.data && albums.data.length === 0) {
    return <p className="py-16 text-center text-[13px] text-ink-3">No albums yet.</p>
  }

  const toggle = (id: string): void =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  const canonical = selected[0] ?? null
  const mergeCount = selected.length > 1 ? selected.length - 1 : 0
  const selectedSet = new Set(selected)

  const doMerge = async (): Promise<void> => {
    if (!canonical || mergeCount === 0) return
    setMerging(true)
    try {
      await mergeAlbums(canonical, selected)
      setSelectMode(false)
      setSelected([])
      void qc.invalidateQueries({ queryKey: ['albums'] })
      void qc.invalidateQueries({ queryKey: ['songs'] })
      void qc.invalidateQueries({ queryKey: ['stats'] })
    } finally {
      setMerging(false)
    }
  }

  const currentAlbum = player.current?.album ?? null
  const currentSelector =
    !selectMode && currentAlbum && list.some((a) => a.title === currentAlbum)
      ? `[data-album-title="${CSS.escape(currentAlbum)}"]`
      : null

  return (
    <div className="flex flex-col">
      <div className="mb-4 flex flex-wrap items-center justify-end gap-2">
        <AlphabetFilter
          value={letter}
          onChange={onLetterChange}
          available={new Set((albums.data ?? []).map((a) => letterKey(a.title)))}
        />
        <SearchBox
          value={search}
          onChange={onSearchChange}
          placeholder="Filter albums…"
          onSearch={onSearch}
        />
        <ThemedSelect
          value={sort}
          onChange={(v) => {
            setSort(v)
            setDirection('asc')
          }}
          options={ALBUM_SORTS}
        />
        <button
          className="rounded-lg border border-surface-4 bg-surface-2 px-2.5 py-1.5 text-[12.5px] text-ink-2 hover:text-ink-0"
          onClick={() => setDirection((d) => (d === 'asc' ? 'desc' : 'asc'))}
        >
          {direction === 'asc' ? '↑' : '↓'}
        </button>
      </div>
      {selectMode && (
        <p className="mb-3 text-[12px] text-ink-3">
          Select albums to merge. The first one you select becomes the keeper.
        </p>
      )}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
      {list.slice(0, visible).map((album) => (
        <Link
          key={album.id}
          to={`/albums/${album.id}`}
            data-album-title={album.title}
            className={cn(
              'group relative flex flex-col gap-2 rounded-xl border border-edge bg-surface-1 p-3 transition-colors',
              selectMode ? 'hover:border-accent/60' : 'hover:border-surface-4',
              selectedSet.has(album.id) && 'border-accent'
            )}
            onClick={(e) => {
              if (selectMode) {
                e.preventDefault()
                toggle(album.id)
              }
            }}
          >
          <Artwork
            songId={album.trackId}
            hasEmbedded={album.hasEmbeddedArtwork}
            label={`${album.title}\n${album.artist}`}
            fluid
            rounded="rounded-lg"
          />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold text-ink-0 group-hover:text-accent">
              {album.title}
            </div>
            <div className="truncate text-[11.5px] text-ink-2">{album.artist}</div>
            <div className="text-[10.5px] text-ink-3">
              {album.year ? `${album.year} · ` : ''}
              {album.trackCount} {album.trackCount === 1 ? 'track' : 'tracks'} ·{' '}
              {formatDuration(album.totalDuration)}
            </div>
          </div>
          {selectMode ? (
            <div
              className={cn(
                'absolute left-3 top-3 flex h-5 w-5 items-center justify-center rounded-full border transition-colors',
                selectedSet.has(album.id)
                  ? 'border-accent bg-accent text-white'
                  : 'border-ink-3 bg-black/40 text-transparent'
              )}
              aria-hidden
            >
              <Check size={12} />
            </div>
          ) : (
            <button
              className={cn(
                'absolute right-4 top-4 hidden rounded-full bg-black/40 p-2 text-white group-hover:block',
                album.favorite && 'block'
              )}
              onClick={(e) => {
                e.preventDefault()
                void toggleFavorite('album', album.id).then(() => qc.invalidateQueries({ queryKey: ['albums'] }))
              }}
              aria-label="Toggle favorite"
            >
              <Heart size={14} className={cn(album.favorite && 'fill-accent text-accent')} />
            </button>
          )}
        </Link>
      ))}
      </div>
      {list.length > visible && <div ref={sentinelRef} className="h-10" />}
      <div className="pointer-events-none sticky bottom-3 z-30 flex justify-end px-6">
        <div className="pointer-events-auto flex items-center gap-2">
          <MergeActions
            selectMode={selectMode}
            mergeCount={mergeCount}
            merging={merging}
            onEnter={() => setSelectMode(true)}
            onCancel={() => {
              setSelectMode(false)
              setSelected([])
            }}
            onMerge={() => void doMerge()}
          />
          <ListJumpButtons currentSelector={currentSelector} />
        </div>
      </div>
    </div>
  )
}

export function ArtistGrid({
  search,
  onSearchChange,
  letter,
  onLetterChange,
  onSearch
}: {
  search: string
  onSearchChange: (v: string) => void
  letter: string | null
  onLetterChange: (v: string | null) => void
  onSearch?: (v: string) => void
}): React.JSX.Element {
  const qc = useQueryClient()
  const artists = useQuery({ queryKey: ['artists'], queryFn: getArtists })
  const player = usePlayer(useShallow((s) => ({ current: s.current })))
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [merging, setMerging] = useState(false)
  const [sort, setSort] = useState('name')
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc')

  const term = search.trim().toLowerCase()
  const cmpKey = (a: Artist): string | number => {
    if (sort === 'albumCount') return a.albumCount ?? 0
    if (sort === 'trackCount') return a.trackCount ?? 0
    return a.name.toLowerCase()
  }
  const list = (artists.data ?? [])
    .filter((a) => a.trackCount > 0)
    .filter((a) => !term || a.name.toLowerCase().includes(term))
    .filter((a) => !letter || letterKey(a.name) === letter)
    .slice()
    .sort((a, b) => {
      const ka = cmpKey(a)
      const kb = cmpKey(b)
      const cmp =
        typeof ka === 'number' && typeof kb === 'number'
          ? ka - kb
          : String(ka).localeCompare(String(kb))
      return direction === 'asc' ? cmp : -cmp
    })

  const { visible, sentinelRef } = useIncrementalRender(list.length, 120)

  if (artists.data && artists.data.length === 0) {
    return <p className="py-16 text-center text-[13px] text-ink-3">No artists yet.</p>
  }

  const toggle = (id: string): void =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  const canonical = selected[0] ?? null
  const mergeCount = selected.length > 1 ? selected.length - 1 : 0
  const selectedSet = new Set(selected)

  const doMerge = async (): Promise<void> => {
    if (!canonical || mergeCount === 0) return
    setMerging(true)
    try {
      await mergeArtists(canonical, selected)
      setSelectMode(false)
      setSelected([])
      void qc.invalidateQueries({ queryKey: ['artists'] })
      void qc.invalidateQueries({ queryKey: ['songs'] })
      void qc.invalidateQueries({ queryKey: ['stats'] })
    } finally {
      setMerging(false)
    }
  }

  const currentArtist = player.current?.artist ?? null
  const currentSelector =
    !selectMode && currentArtist && list.some((a) => a.name === currentArtist)
      ? `[data-artist-name="${CSS.escape(currentArtist)}"]`
      : null

  return (
    <div className="flex flex-col">
      <div className="mb-4 flex flex-wrap items-center justify-end gap-2">
        <AlphabetFilter
          value={letter}
          onChange={onLetterChange}
          available={new Set((artists.data ?? []).map((a) => letterKey(a.name)))}
        />
        <SearchBox
          value={search}
          onChange={onSearchChange}
          placeholder="Filter artists…"
          onSearch={onSearch}
        />
        <ThemedSelect
          value={sort}
          onChange={(v) => {
            setSort(v)
            setDirection('asc')
          }}
          options={ARTIST_SORTS}
        />
        <button
          className="rounded-lg border border-surface-4 bg-surface-2 px-2.5 py-1.5 text-[12.5px] text-ink-2 hover:text-ink-0"
          onClick={() => setDirection((d) => (d === 'asc' ? 'desc' : 'asc'))}
        >
          {direction === 'asc' ? '↑' : '↓'}
        </button>
      </div>
      {selectMode && (
        <p className="mb-3 text-[12px] text-ink-3">
          Select artists to merge. The first one you select becomes the keeper.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
      {list.slice(0, visible).map((artist) => (
        <Link
          key={artist.id}
          to={`/artists/${artist.id}`}
          data-artist-name={artist.name}
          className={cn(
            'group relative flex min-w-0 flex-col items-center gap-2 rounded-xl border border-edge bg-surface-1 p-4 text-center transition-colors',
            selectMode ? 'hover:border-accent/60' : 'hover:border-surface-4',
            selectedSet.has(artist.id) && 'border-accent'
          )}
          onClick={(e) => {
            if (selectMode) {
              e.preventDefault()
              toggle(artist.id)
            }
          }}
        >
          <ArtworkFallback
            label={artist.name}
            size={72}
            rounded="rounded-full"
            className="group-hover:opacity-90"
          />
          <div className="w-full min-w-0">
            <div className="truncate text-[13px] font-semibold text-ink-0 group-hover:text-accent">
              {artist.name}
            </div>
            <div className="text-[11px] text-ink-3">
              {artist.albumCount} {artist.albumCount === 1 ? 'album' : 'albums'} ·{' '}
              {formatCount(artist.trackCount)} tracks
            </div>
          </div>
          {selectMode && (
            <div
              className={cn(
                'absolute left-4 top-4 flex h-5 w-5 items-center justify-center rounded-full border transition-colors',
                selectedSet.has(artist.id)
                  ? 'border-accent bg-accent text-white'
                  : 'border-ink-3 bg-black/40 text-transparent'
              )}
              aria-hidden
            >
              <Check size={12} />
            </div>
          )}
        </Link>
      ))}
      </div>
      {list.length > visible && <div ref={sentinelRef} className="h-10" />}
      <div className="pointer-events-none sticky bottom-3 z-30 flex justify-end px-6">
        <div className="pointer-events-auto flex items-center gap-2">
          <MergeActions
            selectMode={selectMode}
            mergeCount={mergeCount}
            merging={merging}
            onEnter={() => setSelectMode(true)}
            onCancel={() => {
              setSelectMode(false)
              setSelected([])
            }}
            onMerge={() => void doMerge()}
          />
          <ListJumpButtons currentSelector={currentSelector} />
        </div>
      </div>
    </div>
  )
}

function MergeActions({
  selectMode,
  mergeCount,
  merging,
  onEnter,
  onCancel,
  onMerge
}: {
  selectMode: boolean
  mergeCount: number
  merging: boolean
  onEnter: () => void
  onCancel: () => void
  onMerge: () => void
}): React.JSX.Element {
  const btn =
    'flex h-8 items-center gap-1.5 rounded-lg border border-edge bg-surface-2 px-3 text-[12px] font-semibold text-ink-2 shadow-md shadow-black/25 transition-colors hover:border-accent hover:text-ink-0 disabled:cursor-not-allowed disabled:opacity-40'
  if (!selectMode) {
    return (
      <Tip label="Merge duplicate entries">
        <button className={btn} onClick={onEnter} aria-label="Merge duplicate entries">
          <Merge size={14} /> Merge
        </button>
      </Tip>
    )
  }
  return (
    <>
      <button className={btn} onClick={onCancel} aria-label="Cancel merge selection">
        <X size={14} /> Cancel
      </button>
      <button
        className={btn}
        onClick={onMerge}
        disabled={merging || mergeCount === 0}
        aria-label="Merge selected entries"
      >
        {merging ? <Loader2 size={14} className="animate-spin" /> : <Merge size={14} />}
        {mergeCount > 0 ? `Merge ${mergeCount}` : 'Merge'}
      </button>
    </>
  )
}
