import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlbumGrid } from '../components/AlbumArtistGrids'
import { LibraryStatsTabs } from '../components/LibraryStatsTabs'
import { SearchBox } from '../components/SearchBox'
import { search as runSearch } from '../lib/ipc'

export function Albums(): React.JSX.Element {
  const navigate = useNavigate()
  const [onlineSearch, setOnlineSearch] = useState('')
  const [filter, setFilter] = useState('')
  const [letter, setLetter] = useState<string | null>(null)
  return (
    <div className="p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold text-ink-0">Albums</h1>
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
      <LibraryStatsTabs />
      <AlbumGrid
        search={filter}
        onSearchChange={setFilter}
        letter={letter}
        onLetterChange={setLetter}
      />
    </div>
  )
}