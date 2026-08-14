import { useQuery } from '@tanstack/react-query'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { getArtistById, getArtistSongs, getArtistAlbums } from '../lib/ipc'
import { SongTable } from '../components/SongTable'
import { ArtworkFallback } from '../components/Artwork'
import { formatCount } from '../lib/format'

export function ArtistDetail(): React.JSX.Element {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const artist = useQuery({
    queryKey: ['artist', id],
    queryFn: () => getArtistById(id ?? ''),
    enabled: Boolean(id)
  })
  const songs = useQuery({
    queryKey: ['artist-songs', id],
    queryFn: () => getArtistSongs(id ?? ''),
    enabled: Boolean(id)
  })
  const albums = useQuery({
    queryKey: ['artist-albums', id],
    queryFn: () => getArtistAlbums(id ?? ''),
    enabled: Boolean(id)
  })

  if (artist.isLoading || !artist.data) {
    return (
      <div className="p-6">
        <div className="mb-6 h-36 w-36 animate-pulse rounded-full bg-surface-2" />
        <div className="p-4 text-[13px] text-ink-3">Loading…</div>
      </div>
    )
  }

  const a = artist.data

  return (
    <div className="p-6">
      <button
        className="mb-4 flex items-center gap-1.5 text-[12.5px] text-ink-3 hover:text-ink-0"
        onClick={() => navigate(-1)}
      >
        <ArrowLeft size={14} /> Back
      </button>
      <div className="mb-6 flex items-center gap-5">
        <ArtworkFallback label={a.name} size={120} rounded="rounded-2xl" />
        <div className="min-w-0">
          <div className="text-[11px] font-bold uppercase tracking-widest text-ink-3">Artist</div>
          <h1 className="truncate text-3xl font-extrabold text-ink-0">{a.name}</h1>
          <div className="mt-2 text-[12px] text-ink-3">
            {a.albumCount} albums · {formatCount(a.trackCount)} tracks
            {a.genre ? ` · ${a.genre}` : ''}
          </div>
          {a.biography && (
            <p className="mt-3 max-w-2xl text-[12.5px] leading-relaxed text-ink-2 line-clamp-3">
              {a.biography}
            </p>
          )}
        </div>
      </div>

      {albums.data && albums.data.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-2 text-[14px] font-bold text-ink-0">Albums</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {albums.data.map((album) => (
              <ArtistAlbumCard key={album.id} name={album.title} subtitle={album.year ? String(album.year) : ''} />
            ))}
          </div>
        </div>
      )}

      <h2 className="mb-2 text-[14px] font-bold text-ink-0">Songs</h2>
      <SongTable
        tracks={songs.data ?? []}
        source={{ source: 'artist', sourceId: a.id }}
        showAlbum
        showArtist={false}
      />
    </div>
  )
}

function ArtistAlbumCard({ name, subtitle }: { name: string; subtitle: string }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-edge bg-surface-1 p-3 transition-colors hover:border-surface-4">
      <ArtworkFallback label={name} fluid />
      <div className="min-w-0">
        <div className="truncate text-[12.5px] font-semibold text-ink-0">{name}</div>
        {subtitle && <div className="text-[10.5px] text-ink-3">{subtitle}</div>}
      </div>
    </div>
  )
}