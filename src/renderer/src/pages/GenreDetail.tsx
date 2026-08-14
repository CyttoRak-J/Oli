import { useQuery } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { getGenreSongs } from '../lib/ipc'
import { SongTable } from '../components/SongTable'

export function GenreDetail(): React.JSX.Element {
  const { name } = useParams<{ name: string }>()
  const decoded = name ? decodeURIComponent(name) : ''
  const songs = useQuery({
    queryKey: ['genre-songs', decoded],
    queryFn: () => getGenreSongs(decoded),
    enabled: Boolean(decoded)
  })

  return (
    <div className="p-6">
      <h1 className="mb-5 text-2xl font-bold text-ink-0">{decoded}</h1>
      <SongTable
        tracks={songs.data ?? []}
        source={{ source: 'library', sourceId: null }}
      />
    </div>
  )
}