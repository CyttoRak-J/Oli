import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { Search as SearchIcon, X, Loader2 } from 'lucide-react'
import type { Track } from '@shared/types'
import {
  search as runSearch,
  getSearchHistory,
  clearSearchHistory,
  removeSearchHistory,
  pinSearch,
  unpinSearch,
  resolveYouTubeUrl
} from '../lib/ipc'
import { useLiveOnlineSearch } from '../lib/useLiveOnlineSearch'
import { usePlayer } from '../store/player'
import { LocalRow } from '../components/LocalRow'
import { OnlineRow } from '../components/OnlineRow'
import { HistoryPanel } from '../components/HistoryPanel'
import { EmptyState } from '../components/EmptyState'
import { detectYtInput } from '../lib/linkDetect'

export function Search(): React.JSX.Element {
  const playTracks = usePlayer((s) => s.playTracks)
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState(() => params.get('q') ?? '')
  const [debounced, setDebounced] = useState(() => params.get('q') ?? '')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const link = detectYtInput(debounced)

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setDebounced(query.trim()), 300)
    setParams({ q: query.trim() }, { replace: true })
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [query, setParams])

  const results = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => runSearch(debounced),
    enabled: debounced.length > 2 && !link
  })

  // When a YouTube URL is pasted, resolve it to playable results
  const urlResults = useQuery({
    queryKey: ['resolve-url', debounced],
    queryFn: () => resolveYouTubeUrl(debounced),
    enabled: !!link && debounced.length > 5
  })

  const history = useQuery({
    queryKey: ['search-history'],
    queryFn: getSearchHistory,
    enabled: debounced.length === 0
  })

  const local: Track[] = results.data?.local ?? []
  const online = results.data?.online ?? []
  const urlItems = urlResults.data ?? []
  useLiveOnlineSearch(debounced)

  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-bold text-ink-0">Search</h1>

      <div className="relative mb-6 max-w-xl">
        <SearchIcon size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-3" />
        <input
          autoFocus
          className="w-full rounded-full border border-surface-4 bg-surface-2 py-2.5 pl-11 pr-10 text-[14px] text-ink-0 outline-none focus:border-accent"
          placeholder="Search your library, paste a link, or type a name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && query.trim().length >= 2 && !detectYtInput(query.trim())) {
              void runSearch(query.trim(), undefined, true)
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
      </div>

      {debounced.length === 0 && (
        <HistoryPanel
          items={history.data ?? []}
          onRemove={(id) => void removeSearchHistory(id).then(() => history.refetch())}
          onPin={(id, pinned) =>
            void (pinned ? unpinSearch(id) : pinSearch(id)).then(() => history.refetch())
          }
          onClear={() => void clearSearchHistory().then(() => history.refetch())}
          onPick={(q) => setQuery(q)}
        />
      )}

      {debounced.length > 0 && (
        <div className="space-y-8">
          {/* YouTube URL resolved to playable results */}
          {link && urlResults.isLoading && (
            <div className="flex items-center gap-2 py-4 text-[12.5px] text-ink-3">
              <Loader2 size={14} className="animate-spin" />
              Resolving link…
            </div>
          )}

          {link && urlItems.length > 0 && (
            <section>
              <h2 className="mb-2 text-[14px] font-bold text-ink-0">
                {urlItems.length === 1 ? 'YouTube video' : `YouTube playlist (${urlItems.length} songs)`}
              </h2>
              <div className="flex flex-col">
                {urlItems.map((r) => (
                  <OnlineRow key={r.id} result={r} />
                ))}
              </div>
            </section>
          )}

          {link && !urlResults.isLoading && urlItems.length === 0 && urlResults.isFetched && (
            <EmptyState
              title="Could not resolve link"
              description="This URL could not be resolved. Check the link and try again."
            />
          )}

          {/* Normal search results */}
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
                  <OnlineRow key={`${r.provider}-${r.id}`} result={r} />
                ))}
              </div>
            </section>
          )}

          {!link && results.isFetched && !(results.data?.onlineDone ?? false) && (
            <div className="flex items-center gap-2 py-4 text-[12.5px] text-ink-3">
              <Loader2 size={14} className="animate-spin" />
              Searching online providers…
            </div>
          )}

          {!link && local.length === 0 && online.length === 0 && results.isFetched && (
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
