import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  Play,
  ListPlus,
  SkipForward,
  Heart,
  FolderOpen,
  RefreshCw,
  Loader2,
  Music,
  FileText,
  Tags,
  Info,
  Disc3,
  Headphones
} from 'lucide-react'
import {
  getSongById,
  getAlbumById,
  getLyrics,
  toggleFavorite,
  revealInExplorer
} from '../lib/ipc'
import { usePlayer } from '../store/player'
import { useShallow } from 'zustand/react/shallow'
import { Artwork } from '../components/Artwork'
import { EmptyState } from '../components/EmptyState'
import { formatDuration, formatFileSize, relativeTime } from '../lib/format'
import { cn } from '../components/cn'

function Row({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
        {label}
      </span>
      <span className="min-w-0 truncate text-right text-[12.5px] text-ink-1">{value ?? '—'}</span>
    </div>
  )
}

function Section({
  icon,
  title,
  children
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="rounded-xl border border-edge bg-surface-1 p-4">
      <h2 className="mb-2 flex items-center gap-2 text-[12px] font-bold uppercase tracking-widest text-ink-3">
        {icon}
        {title}
      </h2>
      <div className="flex flex-col">{children}</div>
    </section>
  )
}

export function SongDetail(): React.JSX.Element {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const player = usePlayer(
    useShallow((s) => ({ addToQueue: s.addToQueue, patchTrack: s.patchTrack, playNext: s.playNext, playTracks: s.playTracks }))
  )
  const qc = useQueryClient()
  const [lyricsTick, setLyricsTick] = useState(0)

  const trackQuery = useQuery({
    queryKey: ['song', id],
    queryFn: () => getSongById(id)
  })
  const track = trackQuery.data

  const albumQuery = useQuery({
    queryKey: ['album', track?.albumId],
    queryFn: () => (track?.albumId ? getAlbumById(track.albumId) : Promise.resolve(null)),
    enabled: Boolean(track?.albumId)
  })

  const lyricsQuery = useQuery({
    queryKey: ['lyrics', id, lyricsTick],
    queryFn: () => getLyrics(id, lyricsTick > 0),
    enabled: Boolean(track) && !track?.error,
    retry: false
  })

  if (trackQuery.isLoading) {
    return (
      <div className="flex items-center justify-center p-16">
        <Loader2 size={20} className="animate-spin text-ink-3" />
      </div>
    )
  }

  if (!track) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<Music size={36} className="mx-auto" />}
          title="Song not found"
          description="This track is no longer in your library."
        />
      </div>
    )
  }

  const isOnline = Boolean(track.streamUrl || track.artworkUrl)
  const quality =
    track.bitrate && track.bitrate > 0
      ? `${Math.round(track.bitrate / 1000)} kbps`
      : track.sampleRate && track.sampleRate > 0
        ? `${Math.round(track.sampleRate / 1000)} kHz`
        : null
  const lossless = Boolean(track.bitDepth && track.sampleRate && !track.bitrate)

  const onToggleFav = (): void => {
    void toggleFavorite('song', track.id).then((fav) => {
      player.patchTrack(track.id, { favorite: fav })
      void qc.invalidateQueries({ queryKey: ['song', id] })
    })
  }

  return (
    <div className="p-6">
      <button
        className="mb-4 flex items-center gap-1.5 text-[12.5px] text-ink-3 transition-colors hover:text-ink-0"
        onClick={() => navigate(-1)}
      >
        <ArrowLeft size={14} /> Back
      </button>

      <div className="mb-5 flex flex-col gap-5 rounded-xl border border-edge bg-surface-1 p-5 sm:flex-row">
        <Artwork
          songId={track.id}
          hasEmbedded={track.hasEmbeddedArtwork}
          artworkUrl={track.artworkUrl ?? undefined}
          label={`${track.title} ${track.artist}`}
          size={200}
          rounded="rounded-2xl"
          className="shrink-0 shadow-xl shadow-black/30"
        />
        <div className="min-w-0 flex-1">
          <div className="mb-1 text-[11px] font-bold uppercase tracking-widest text-ink-3">
            {isOnline ? 'Online track' : 'Library track'}
          </div>
          <h1 className="mb-1 break-words text-[22px] font-bold leading-tight text-ink-0">
            {track.title}
          </h1>
          <div className="mb-3 text-[13.5px] text-ink-2">
            {track.artistId ? (
              <Link to={`/artists/${track.artistId}`} className="hover:text-accent">
                {track.artist}
              </Link>
            ) : (
              track.artist
            )}
            {track.album ? (
              <>
                {' · '}
                {track.albumId ? (
                  <Link to={`/albums/${track.albumId}`} className="hover:text-accent">
                    {track.album}
                  </Link>
                ) : (
                  track.album
                )}
              </>
            ) : null}
          </div>

          <div className="mb-4 flex flex-wrap gap-1.5">
            <Chip>{formatDuration(track.duration)}</Chip>
            {quality && <Chip>{quality}</Chip>}
            {lossless && <Chip>Lossless</Chip>}
            {track.format && <Chip>{track.format}</Chip>}
            {track.genre && <Chip>{track.genre}</Chip>}
            {track.year && <Chip>{track.year}</Chip>}
            {track.favorite && <Chip highlight>Favorite</Chip>}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90"
              onClick={() =>
                player.playTracks([track], 0, { source: 'library', sourceId: null })
              }
            >
              <Play size={14} className="fill-current" /> Play
            </button>
            <button
              className="flex items-center gap-1.5 rounded-lg border border-surface-4 bg-surface-2 px-3 py-2 text-[12.5px] text-ink-1 transition-colors hover:border-accent"
              onClick={() => player.addToQueue(track)}
            >
              <ListPlus size={14} /> Queue
            </button>
            <button
              className="flex items-center gap-1.5 rounded-lg border border-surface-4 bg-surface-2 px-3 py-2 text-[12.5px] text-ink-1 transition-colors hover:border-accent"
              onClick={() => player.playNext(track)}
            >
              <SkipForward size={14} /> Play next
            </button>
            <button
              className="flex items-center gap-1.5 rounded-lg border border-surface-4 bg-surface-2 px-3 py-2 text-[12.5px] text-ink-1 transition-colors hover:border-accent"
              onClick={onToggleFav}
            >
              <Heart size={14} className={cn(track.favorite && 'fill-accent text-accent')} />
              {track.favorite ? 'Favorited' : 'Favorite'}
            </button>
            {!isOnline && (
              <button
                className="flex items-center gap-1.5 rounded-lg border border-surface-4 bg-surface-2 px-3 py-2 text-[12.5px] text-ink-1 transition-colors hover:border-accent"
                onClick={() => void revealInExplorer(track.path)}
              >
                <FolderOpen size={14} /> Reveal
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <Section icon={<Tags size={13} />} title="Metadata">
            <Row label="Artist" value={track.artist} />
            {track.albumArtist && <Row label="Album artist" value={track.albumArtist} />}
            <Row label="Album" value={track.album} />
            {track.genre && <Row label="Genre" value={track.genre} />}
            {track.composer && <Row label="Composer" value={track.composer} />}
            {track.year && <Row label="Year" value={track.year} />}
            {track.releaseDate && <Row label="Release" value={track.releaseDate} />}
            {track.trackNo && <Row label="Track #" value={track.trackNo} />}
            {track.discNo && <Row label="Disc #" value={track.discNo} />}
            {track.isrc && <Row label="ISRC" value={track.isrc} />}
            {track.rating != null && <Row label="Rating" value={`${track.rating} / 5`} />}
          </Section>

          <Section icon={<Disc3 size={13} />} title="Audio quality">
            <Row label="Quality" value={quality ?? (lossless ? 'Lossless' : '—')} />
            <Row label="Format" value={track.format} />
            {track.codec && <Row label="Codec" value={track.codec} />}
            {track.bitrate && <Row label="Bitrate" value={`${Math.round(track.bitrate / 1000)} kbps`} />}
            {track.sampleRate && (
              <Row label="Sample rate" value={`${Math.round(track.sampleRate / 1000)} kHz`} />
            )}
            {track.bitDepth && <Row label="Bit depth" value={`${track.bitDepth}-bit`} />}
            {track.channels && <Row label="Channels" value={track.channels} />}
            {track.duration > 0 && <Row label="Duration" value={formatDuration(track.duration)} />}
          </Section>
        </div>

        <div className="flex flex-col gap-4">
          <Section icon={<Info size={13} />} title="Source & file">
            <Row label="Source" value={isOnline ? 'Online (stream)' : 'Local library'} />
            <Row label="Folder" value={track.folderId ? `Folder #${track.folderId}` : '—'} />
            {!isOnline && <Row label="File size" value={formatFileSize(track.fileSize)} />}
            {!isOnline && <Row label="Path" value={track.path} />}
            {track.addedAt > 0 && <Row label="Added" value={relativeTime(track.addedAt)} />}
            {track.modifiedAt > 0 && <Row label="Modified" value={relativeTime(track.modifiedAt)} />}
            {track.lastPlayedAt != null && track.lastPlayedAt > 0 && (
              <Row label="Last played" value={relativeTime(track.lastPlayedAt)} />
            )}
            {track.playCount != null && track.playCount > 0 && (
              <Row label="Play count" value={track.playCount} />
            )}
            {track.replayGain != null && (
              <Row label="ReplayGain" value={`${track.replayGain.toFixed(2)} dB`} />
            )}
            {isOnline && track.album && (
              <Row label="Source album" value={albumQuery.data?.title ?? track.album} />
            )}
          </Section>

          <section className="rounded-xl border border-edge bg-surface-1 p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-[12px] font-bold uppercase tracking-widest text-ink-3">
                <FileText size={13} />
                Lyrics
              </h2>
              <button
                className="flex items-center gap-1 text-[11.5px] text-ink-3 transition-colors hover:text-ink-0"
                onClick={() => setLyricsTick((t) => t + 1)}
              >
                <RefreshCw size={12} className={cn(lyricsQuery.isFetching && 'animate-spin')} />
                Refresh
              </button>
            </div>
            {lyricsQuery.isLoading ? (
              <div className="flex items-center gap-2 py-4 text-[12.5px] text-ink-3">
                <Loader2 size={13} className="animate-spin" /> Loading lyrics…
              </div>
            ) : lyricsQuery.data?.lyrics ? (
              <div>
                {lyricsQuery.data.source && (
                  <div className="mb-1 text-[11px] text-ink-3">
                    {lyricsQuery.data.synced ? 'Synced' : 'Plain text'} · {lyricsQuery.data.source}
                  </div>
                )}
                <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-ink-1">
                  {lyricsQuery.data.lyrics}
                </pre>
              </div>
            ) : (
              <div className="flex flex-col gap-2 py-3">
                <p className="text-[12.5px] text-ink-3">
                  <Headphones size={13} className="mr-1 inline" />
                  No lyrics found.
                </p>
                <button
                  className="self-start rounded-md border border-surface-4 bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-2 transition-colors hover:border-accent"
                  onClick={() => setLyricsTick((t) => t + 1)}
                >
                  Try again / fetch online
                </button>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

function Chip({
  children,
  highlight
}: {
  children: React.ReactNode
  highlight?: boolean
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'rounded-full border border-surface-4 bg-surface-2 px-2.5 py-0.5 text-[11.5px] text-ink-2',
        highlight && 'border-accent/50 text-accent'
      )}
    >
      {children}
    </span>
  )
}
