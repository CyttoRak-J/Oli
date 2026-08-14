import { useEffect, useRef, useState } from 'react'
import { cn } from './cn'
import { embeddedArtworkUrl } from '../lib/artwork'
import { getEmbeddedArtwork } from '../lib/ipc'
import { initialsOf } from '../lib/format'

export interface ArtworkProps {
  songId?: string | null
  hasEmbedded?: boolean
  folderKey?: string | null
  label?: string
  size?: number
  fluid?: boolean
  className?: string
  rounded?: string
  muted?: boolean
  style?: React.CSSProperties
  /** Remote artwork URL (online providers); used directly when present. */
  artworkUrl?: string | null
}

interface ArtworkEntry {
  key: string
  url: string | null
  failed: boolean
}

/**
 * Artwork image with graceful fallback. Tries embedded art synchronously
 * (cheap: just a URL), then asks main for folder artwork if needed.
 */
export function Artwork({
  songId,
  hasEmbedded,
  artworkUrl,
  label,
  size = 48,
  fluid = false,
  className,
  rounded = 'rounded-lg',
  muted = false,
  style
}: ArtworkProps): React.JSX.Element {
  const key = `${songId ?? ''}:${hasEmbedded ? '1' : '0'}:${artworkUrl ?? ''}`
  const [entry, setEntry] = useState<ArtworkEntry>({ key: '', url: null, failed: false })
  const tried = useRef<string | null>(null)

  const initial = hasEmbedded ? embeddedArtworkUrl(songId) : null
  const active = entry.key === key
  const src = active ? entry.url : (artworkUrl ?? initial)
  const failed = active ? entry.failed : false
  const showFallback = failed || !src

  // Songs without embedded art may still have folder or merged-album artwork:
  // probe the main process once so those covers appear too.
  useEffect(() => {
    if (artworkUrl || hasEmbedded || !songId) return
    let cancelled = false
    void getEmbeddedArtwork(songId)
      .then((url) => {
        if (!cancelled && url) setEntry({ key, url, failed: false })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songId, artworkUrl, hasEmbedded])

  const onError = (): void => {
    if (tried.current === key) {
      setEntry({ key, url: null, failed: true })
      return
    }
    tried.current = key
    // Remote artwork has no local fallback; mark failed immediately.
    if (artworkUrl) {
      setEntry({ key, url: null, failed: true })
      return
    }
    void getEmbeddedArtwork(songId ?? '')
      .then((url) => {
        setEntry(url ? { key, url, failed: false } : { key, url: null, failed: true })
      })
      .catch(() => {
        setEntry({ key, url: null, failed: true })
      })
  }

  return (
    <div
      className={cn(
        'relative shrink-0 overflow-hidden bg-surface-3',
        fluid && 'aspect-square w-full',
        rounded,
        className
      )}
      style={style ?? (fluid ? undefined : { width: size, height: size })}
    >
      {src && !failed && (
        <img
          src={src}
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
          onError={onError}
        />
      )}
      {showFallback && (
        <div
          className={cn(
            'flex h-full w-full items-center justify-center',
            muted
              ? 'bg-surface-2 text-ink-2'
              : 'bg-gradient-to-br from-[#312e81] to-[#9d174d] text-ink-0'
          )}
        >
          <span
            className="font-semibold leading-none text-ink-0/70"
            style={{ fontSize: Math.max(9, (fluid ? 48 : size) * 0.32) }}
          >
            {initialsOf(label ?? '')}
          </span>
        </div>
      )}
    </div>
  )
}

/** Placeholder box used for albums/artists before artwork resolves. */
export function ArtworkFallback({
  label,
  size = 48,
  className,
  rounded = 'rounded-lg'
}: Omit<ArtworkProps, 'songId' | 'hasEmbedded'>): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center bg-gradient-to-br from-[#312e81] to-[#9d174d]',
        rounded,
        className
      )}
      style={{ width: size, height: size }}
    >
      <span
        className="font-semibold leading-none text-ink-0/70"
        style={{ fontSize: Math.max(9, size * 0.32) }}
      >
        {initialsOf(label ?? '')}
      </span>
    </div>
  )
}