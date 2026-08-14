import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Disc3, Music, Users, ListMusic, Heart } from 'lucide-react'
import type { Track } from '@shared/types'
import { getSongs, getAlbums, getArtists, getPlaylists } from '../lib/ipc'
import { SongTable } from '../components/SongTable'
import { Artwork } from '../components/Artwork'
import { cn } from '../components/cn'
import { EmptyState } from '../components/EmptyState'

type Tab = 'songs' | 'albums' | 'artists' | 'playlists'

const TABS: Array<{ key: Tab; label: string; icon: React.ReactNode }> = [
  { key: 'songs', label: 'Songs', icon: <Music size={14} /> },
  { key: 'albums', label: 'Albums', icon: <Disc3 size={14} /> },
  { key: 'artists', label: 'Artists', icon: <Users size={14} /> },
  { key: 'playlists', label: 'Playlists', icon: <ListMusic size={14} /> }
]

export function Favorites(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('songs')

  const songs = useQuery({
    queryKey: ['favorite-songs'],
    queryFn: () => getSongs({ favoritesOnly: true })
  })
  const albums = useQuery({ queryKey: ['albums'], queryFn: getAlbums })
  const artists = useQuery({ queryKey: ['artists'], queryFn: getArtists })
  const playlists = useQuery({ queryKey: ['playlists'], queryFn: getPlaylists })

  const favAlbums = (albums.data ?? []).filter((a) => a.favorite)
  const favArtists = (artists.data ?? []).filter((a) => a.favorite)
  const favPlaylists = (playlists.data ?? []).filter((p) => p.favorite)
  const favTracks: Track[] = (songs.data?.tracks ?? []).filter((t) => t.favorite)

  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-bold text-ink-0">Favorites</h1>

      <div className="mb-5 flex items-center gap-1 border-b border-edge pb-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
              tab === t.key ? 'bg-surface-2 text-accent' : 'text-ink-2 hover:text-ink-0'
            )}
            onClick={() => setTab(t.key)}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'songs' &&
        (favTracks.length === 0 ? (
          <EmptyState
            icon={<Heart size={36} className="mx-auto" />}
            title="No favorite songs"
            description="Tap the heart beside any track to collect it here."
          />
        ) : (
          <SongTable tracks={favTracks} source={{ source: 'favorites', sourceId: null }} />
        ))}

      {tab === 'albums' && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {favAlbums.map((album) => (
            <Link
              key={album.id}
              to={`/albums/${album.id}`}
              className="flex flex-col gap-2 rounded-xl border border-edge bg-surface-1 p-3 transition-colors hover:border-surface-4"
            >
              <Artwork songId={album.trackId} hasEmbedded={album.hasEmbeddedArtwork} label={album.title} fluid />
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold text-ink-0">{album.title}</div>
                <div className="truncate text-[11px] text-ink-2">{album.artist}</div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {tab === 'artists' && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {favArtists.map((artist) => (
            <Link
              key={artist.id}
              to={`/artists/${artist.id}`}
              className="rounded-xl border border-edge bg-surface-1 p-4 text-center transition-colors hover:border-surface-4"
            >
              <div className="mx-auto mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-[#312e81] to-[#9d174d] text-base font-bold text-ink-0/70">
                {artist.name.slice(0, 2).toUpperCase()}
              </div>
              <div className="truncate text-[13px] font-semibold text-ink-0">{artist.name}</div>
            </Link>
          ))}
        </div>
      )}

      {tab === 'playlists' && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {favPlaylists.map((p) => (
            <Link
              key={p.id}
              to={`/playlists/${p.id}`}
              className="flex items-center gap-3 rounded-xl border border-edge bg-surface-1 p-3 transition-colors hover:border-surface-4"
            >
              <ListMusic size={20} className="text-ink-2" />
              <div className="min-w-0">
                <div className="truncate text-[13.5px] font-semibold text-ink-0">{p.name}</div>
                <div className="text-[11px] text-ink-3">{p.trackCount} tracks</div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}