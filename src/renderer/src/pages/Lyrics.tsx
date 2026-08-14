import { useEffect, useState } from 'react'
import { Mic2, RefreshCw, Loader2 } from 'lucide-react'
import { getLyrics } from '../lib/ipc'
import { usePlayer } from '../store/player'
import type { LyricsData } from '@shared/types'
import { EmptyState } from '../components/EmptyState'

type CacheValue = LyricsData | { error: true }

export function Lyrics(): React.JSX.Element {
  const song = usePlayer((s) => s.current)
  const [cache, setCache] = useState<Record<string, CacheValue>>({})
  const [forcedRefresh, setForcedRefresh] = useState(0)

  const key = song ? `${song.id}:${forcedRefresh}` : ''
  const entry = key ? cache[key] : undefined
  const loading = Boolean(song && entry === undefined)

  useEffect(() => {
    if (!song || cache[key]) return
    let cancelled = false
    void getLyrics(song.id, forcedRefresh > 0)
      .then((res) => {
        if (!cancelled) setCache((m) => ({ ...m, [key]: res ?? { error: true } }))
      })
      .catch(() => {
        if (!cancelled) setCache((m) => ({ ...m, [key]: { error: true } }))
      })
    return () => {
      cancelled = true
    }
  }, [key, song, cache, forcedRefresh])

  if (!song) {
    return (
      <div className="p-6">
        <EmptyState icon={<Mic2 size={40} className="mx-auto" />} title="Nothing playing" description="Start a track to see its lyrics." />
      </div>
    )
  }

  const data: LyricsData | null = entry && !('error' in entry) ? entry : null
  const error = entry && 'error' in entry ? true : false

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-ink-0">{song.title}</h1>
          <div className="text-[13px] text-ink-2">{song.artist}</div>
        </div>
        <button
          className="flex items-center gap-1.5 rounded-lg border border-surface-4 bg-surface-2 px-3 py-1.5 text-[12px] text-ink-2 hover:border-accent"
          onClick={() => setForcedRefresh((n) => n + 1)}
          disabled={loading}
        >
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          Refresh
        </button>
      </div>

      {loading && <p className="py-10 text-center text-[13px] text-ink-3">Loading lyrics…</p>}

      {!loading && data && (
        <div>
          {data.source && (
            <div className="mb-3 text-[11px] uppercase tracking-wide text-ink-3">
              {data.synced ? 'Synced' : ''} lyrics · {data.source}
            </div>
          )}
          <pre className="whitespace-pre-wrap font-sans text-[14px] leading-relaxed text-ink-1">
            {data.lyrics}
          </pre>
        </div>
      )}

      {!loading && !data && !error && (
        <EmptyState
          icon={<Mic2 size={36} className="mx-auto" />}
          title="No lyrics found"
          description="No synchronized or plain-text lyrics were found for this track."
        />
      )}
      {error && <p className="py-10 text-center text-[13px] text-ink-3">Could not load lyrics.</p>}
    </div>
  )
}