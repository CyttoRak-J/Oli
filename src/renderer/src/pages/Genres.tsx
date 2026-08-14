import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { getGenres, search as runSearch } from '../lib/ipc'
import { cn } from '../components/cn'
import { formatCount } from '../lib/format'
import { AlphabetFilter, letterKey } from '../components/AlphabetFilter'
import { SearchBox } from '../components/SearchBox'

export function Genres(): React.JSX.Element {
  const navigate = useNavigate()
  const [onlineSearch, setOnlineSearch] = useState('')
  const [filter, setFilter] = useState('')
  const [letter, setLetter] = useState<string | null>(null)
  const genres = useQuery({ queryKey: ['genres'], queryFn: getGenres })

  const list = (genres.data ?? [])
    .filter((g) => g.name.toLowerCase().includes(filter.toLowerCase()))
    .filter((g) => !letter || letterKey(g.name) === letter)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))

  return (
    <div className="p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold text-ink-0">Genres</h1>
        <SearchBox
          value={onlineSearch}
          onChange={setOnlineSearch}
          placeholder="Search online…"
          onSearch={(v) => {
            void runSearch(v, undefined, true)
            navigate(`/search?q=${encodeURIComponent(v)}`)
          }}
        />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <AlphabetFilter
          value={letter}
          onChange={setLetter}
          available={new Set((genres.data ?? []).map((g) => letterKey(g.name)))}
        />
        <SearchBox value={filter} onChange={setFilter} placeholder="Filter genres…" />
      </div>

      {genres.isLoading && <p className="py-16 text-center text-[13px] text-ink-3">Loading…</p>}

      <div className="flex flex-wrap gap-2">
        {list.map((genre) => (
          <Link
            key={genre.id}
            to={`/genres/${encodeURIComponent(genre.name)}`}
            className={cn(
              'rounded-full border border-edge bg-surface-1 px-4 py-2 text-[13px] text-ink-1 transition-colors',
              'hover:border-accent hover:text-ink-0'
            )}
          >
            {genre.name}
            <span className="ml-2 text-[11px] text-ink-3">{formatCount(genre.trackCount)}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}