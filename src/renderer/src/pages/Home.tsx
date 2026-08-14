import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Search as SearchIcon, X, Loader2 } from 'lucide-react'
import { useLiveOnlineSearch } from '../lib/useLiveOnlineSearch'
import {
  getSongs,
  getAlbums,
  search as runSearch,
  getSearchHistory,
  clearSearchHistory,
  removeSearchHistory,
  pinSearch,
  unpinSearch
} from '../lib/ipc'
import { SongTable } from '../components/SongTable'
import { Artwork } from '../components/Artwork'
import { LibraryStatsTabs } from '../components/LibraryStatsTabs'
import { LocalRow } from '../components/LocalRow'
import { OnlineRow } from '../components/OnlineRow'
import { HistoryPanel } from '../components/HistoryPanel'
import { usePlayer } from '../store/player'
import { EmptyState } from '../components/EmptyState'
import { LinkDownloadForm } from '../components/LinkDownloadForm'
import { detectYtInput } from '../lib/linkDetect'
import type { Album, Track } from '@shared/types'

export function Home(): React.JSX.Element {
  const playTracks = usePlayer((s) => s.playTracks)
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const [recKey, setRecKey] = useState(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const link = useMemo(() => detectYtInput(debounced), [debounced])

  const recommended = useQuery({
    queryKey: ['songs', 'recommended', recKey],
    queryFn: () => getSongs({ sort: 'random', direction: 'desc', limit: 20 })
  })
  const albums = useQuery({ queryKey: ['albums'], queryFn: getAlbums })

  const recent = useMemo(() => recentAlbums(albums.data ?? []), [albums.data])

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setDebounced(query.trim()), 300)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [query])

  const results = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => runSearch(debounced, undefined, false),
    enabled: debounced.length > 2 && !link
  })
  const history = useQuery({
    queryKey: ['search-history'],
    queryFn: getSearchHistory,
    enabled: debounced.length === 0
  })

  const local: Track[] = results.data?.local ?? []
  const online = results.data?.online ?? []
  useLiveOnlineSearch(debounced)

  return (
    <div className="p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-ink-0">Home</h1>
      </div>

      <div className="relative mb-6 max-w-xl">
        <SearchIcon
          size={16}
          className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-3"
        />
        <input
          className="w-full rounded-full border border-surface-4 bg-surface-2 py-2.5 pl-11 pr-10 text-[14px] text-ink-0 outline-none focus:border-accent"
          placeholder="Search your library, then providers…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && query.trim().length > 2 && !detectYtInput(query.trim())) {
              void runSearch(query.trim(), undefined, true)
              setDebounced(query.trim())
            }
          }}
        />
        {query && (
          <button
            className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink-0"
            onClick={() => setQuery('')}
            aria-label="Clear"
          >
            <X size={15} />
          </button>
        )}

        {searchFocused && debounced.length === 0 && history.data && history.data.length > 0 && (
          <div
            className="absolute z-30 mt-2 w-full max-w-xl rounded-xl border border-edge bg-surface-2 p-2 shadow-2xl"
            onMouseDown={(e) => e.preventDefault()}
          >
            <HistoryPanel
              items={history.data.slice(0, 8)}
              onRemove={(id) => void removeSearchHistory(id).then(() => history.refetch())}
              onPin={(id, pinned) =>
                void (pinned ? unpinSearch(id) : pinSearch(id)).then(() => history.refetch())
              }
              onClear={() => void clearSearchHistory().then(() => history.refetch())}
              onPick={(q) => setQuery(q)}
            />
          </div>
        )}
      </div>

      {debounced.length === 0 ? (
        <>
          <LibraryStatsTabs />

          <Section title="Recommended" to="/songs" note="Random picks from your library">
            {recommended.data ? (
              <SongTable
                tracks={recommended.data.tracks.slice(0, 20)}
                source={{ source: 'library', sourceId: null }}
                onRefresh={() => setRecKey((k) => k + 1)}
              />
            ) : null}
          </Section>

          <Section title="Albums" to="/albums">
            {recent.length > 0 && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
                {recent.map((album) => (
                  <AlbumCard key={album.id} album={album} />
                ))}
              </div>
            )}
          </Section>
        </>
      ) : (
        <div className="space-y-8">
          {link && (
            <section>
              <h2 className="mb-2 text-[14px] font-bold text-ink-0">YouTube link detected</h2>
              <LinkDownloadForm link={link} onEnqueued={() => void results.refetch()} />
            </section>
          )}

          {!link && local.length > 0 && (
            <section>
              <h2 className="mb-2 text-[14px] font-bold text-ink-0">Library</h2>
              <div className="flex flex-col">
                {local.map((track) => (
                  <LocalRow
                    key={track.id}
                    track={track}
                    onPlay={() =>
                      playTracks(local, local.indexOf(track), { source: 'search', sourceId: null })
                    }
                  />
                ))}
              </div>
            </section>
          )}

          {!link && online.length > 0 && (
            <section>
              <h2 className="mb-2 text-[14px] font-bold text-ink-0">Online</h2>
              <div className="flex flex-col">
                {online.map((r) => (
                  <OnlineRow key={`${r.provider}-${r.id}`} result={r} variant="home" />
                ))}
              </div>
            </section>
          )}

          {!link && debounced.length > 2 && results.isFetched && !(results.data?.onlineDone ?? false) && (
            <div className="flex items-center gap-2 py-4 text-[12.5px] text-ink-3">
              <Loader2 size={14} className="animate-spin" />
              Searching online providers…
            </div>
          )}

          {!link && debounced.length > 2 && local.length === 0 && online.length === 0 && results.isFetched && (
            (results.data?.onlineDone ?? false) && (
              <EmptyState
                title="No results"
                description="Nothing matched. Configure providers (Spotify/YouTube) in Settings to expand results."
              />
            )
          )}
        </div>
      )}
    </div>
  )
}

function recentAlbums(all: Album[]): Album[] {
  return all
    .filter((a) => a.trackCount > 0)
    .slice()
    .sort((a, b) => b.addedAt - a.addedAt)
    .slice(0, 8)
}

function Section({
  title,
  to,
  note,
  children
}: {
  title: string
  to: string
  note?: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mb-8">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[15px] font-bold text-ink-0">{title}</h2>
          {note && <span className="text-[11.5px] text-ink-3">{note}</span>}
        </div>
        <Link to={to} className="text-[12px] font-medium text-ink-3 hover:text-ink-1">
          See all →
        </Link>
      </div>
      {children}
    </div>
  )
}

function AlbumCard({ album }: { album: Album }): React.JSX.Element {
  return (
    <Link
      to={`/albums/${album.id}`}
      className="group flex flex-col gap-2 rounded-xl border border-edge bg-surface-1 p-3 transition-colors hover:border-surface-4"
    >
      <Artwork
        songId={album.trackId}
        hasEmbedded={album.hasEmbeddedArtwork}
        label={`${album.title}\n${album.artist}`}
        size={32}
        fluid
        className="w-full"
      />
      <div className="min-w-0">
        <div className="truncate text-[12.5px] font-semibold text-ink-0 group-hover:text-accent">
          {album.title}
        </div>
        <div className="truncate text-[11px] text-ink-2">{album.artist}</div>
        {album.year ? <div className="text-[10.5px] text-ink-3">{album.year}</div> : null}
      </div>
    </Link>
  )
}
