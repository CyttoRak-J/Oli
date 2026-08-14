import { useQuery } from '@tanstack/react-query'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { getAlbumById, getAlbumSongs } from '../lib/ipc'
import { SongTable } from '../components/SongTable'
import { Artwork } from '../components/Artwork'
import { formatDuration } from '../lib/format'

export function AlbumDetail(): React.JSX.Element {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const album = useQuery({
    queryKey: ['album', id],
    queryFn: () => getAlbumById(id ?? ''),
    enabled: Boolean(id)
  })
  const songs = useQuery({
    queryKey: ['album-songs', id],
    queryFn: () => getAlbumSongs(id ?? ''),
    enabled: Boolean(id)
  })

  if (album.isLoading || !album.data) {
    return <AlbumSkeleton />
  }

  const a = album.data
  const ordered = (songs.data ?? []).slice().sort((x, y) => {
    const dx = x.discNo ?? 1
    const dy = y.discNo ?? 1
    if (dx !== dy) return dx - dy
    return (x.trackNo ?? 0) - (y.trackNo ?? 0)
  })

  return (
    <div className="p-6">
      <button
        className="mb-4 flex items-center gap-1.5 text-[12.5px] text-ink-3 hover:text-ink-0"
        onClick={() => navigate(-1)}
      >
        <ArrowLeft size={14} /> Back
      </button>
      <div className="mb-6 flex items-end gap-5">
        <Artwork
          songId={a.trackId}
          hasEmbedded={a.hasEmbeddedArtwork}
          label={`${a.title}\n${a.artist}`}
          size={160}
          rounded="rounded-2xl"
        />
        <div className="min-w-0">
          <div className="text-[11px] font-bold uppercase tracking-widest text-ink-3">Album</div>
          <h1 className="truncate text-3xl font-extrabold text-ink-0">{a.title}</h1>
          <div className="mt-1 flex items-center gap-1 text-[13px] text-ink-2">{a.artist}</div>
          <div className="mt-2 text-[12px] text-ink-3">
            {a.trackCount} tracks · {formatDuration(a.totalDuration)}
            {a.year ? ` · ${a.year}` : ''}
            {a.genre ? ` · ${a.genre}` : ''}
          </div>
        </div>
      </div>

      <SongTable
        tracks={ordered}
        source={{ source: 'album', sourceId: a.id }}
        showAlbum={false}
        showArtist={true}
      />
    </div>
  )
}

function AlbumSkeleton(): React.JSX.Element {
  return (
    <div className="p-6">
      <div className="mb-6 h-40 w-40 animate-pulse rounded-2xl bg-surface-2" />
      <div className="p-4 text-[13px] text-ink-3">Loading…</div>
    </div>
  )
}