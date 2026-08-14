import { useEffect, useMemo, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Loader2, RefreshCw, MousePointer2 } from 'lucide-react'
import { IPC } from '@shared/ipc'
import {
  getSongs,
  search as runSearch,
  getNeedsAttention,
  fixMetadataMany,
  fixAllMetadata,
  onMetaFixProgress,
  rescanLibrary,
  on
} from '../lib/ipc'
import { SongTable } from '../components/SongTable'
import { ThemedSelect } from '../components/ThemedSelect'
import { LibraryStatsTabs } from '../components/LibraryStatsTabs'
import { AlphabetFilter, letterKey } from '../components/AlphabetFilter'
import { SearchBox } from '../components/SearchBox'
import { cn } from '../components/cn'
import { usePlayer } from '../store/player'
import type { FixProgress, ScanProgress } from '@shared/types'

const SORTS = [
  { value: 'title', label: 'Title' },
  { value: 'artist', label: 'Artist' },
  { value: 'album', label: 'Album' },
  { value: 'year', label: 'Year' },
  { value: 'addedAt', label: 'Date added' },
  { value: 'lastPlayed', label: 'Recently played' },
  { value: 'playCount', label: 'Most played' },
  { value: 'duration', label: 'Duration' },
  { value: 'random', label: 'Random' }
] as const

const FORMATS = [
  { value: '', label: 'All formats' },
  { value: 'FLAC', label: 'FLAC' },
  { value: 'MP3', label: 'MP3' },
  { value: 'AAC', label: 'AAC' },
  { value: 'WAV', label: 'WAV' },
  { value: 'AIFF', label: 'AIFF' },
  { value: 'OGG', label: 'OGG' },
  { value: 'Opus', label: 'Opus' },
  { value: 'WMA', label: 'WMA' },
  { value: 'WebM', label: 'WebM' }
]

const REASON_LABEL: Record<string, string> = {
  'missing-file': 'file missing on disk',
  'not-a-youtube-download': 'not a YouTube download',
  'no-title': 'no known title for the video',
  'no-match': 'no catalog match found',
  'tag-failed': 'writing tags/cover failed',
  'lookup-error': 'lookup error (provider down?)'
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

export function Songs(): React.JSX.Element {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [onlineSearch, setOnlineSearch] = useState('')
  const [filter, setFilter] = useState('')
  const [debounced, setDebounced] = useState('')
  const [sort, setSort] = useState<string>('title')
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc')
  const [letter, setLetter] = useState<string | null>(null)
  const [format, setFormat] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [fixMode, setFixMode] = useState(false)
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [progress, setProgress] = useState<FixProgress | null>(null)
  const [scanning, setScanning] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(filter.trim()), 250)
    return () => clearTimeout(t)
  }, [filter])

  useEffect(() => {
    return onMetaFixProgress(setProgress)
  }, [])
  useEffect(() => {
    const unsubChanged = on(IPC.onLibraryChanged, () => {
      void queryClient.invalidateQueries({ queryKey: ['songs'] })
      void queryClient.invalidateQueries({ queryKey: ['artists'] })
      void queryClient.invalidateQueries({ queryKey: ['albums'] })
      void queryClient.invalidateQueries({ queryKey: ['genres'] })
      void queryClient.invalidateQueries({ queryKey: ['composers'] })
      void queryClient.invalidateQueries({ queryKey: ['meta-attention'] })
      setScanning(false)
    })
    const unsubProgress = on<ScanProgress>(IPC.onScanProgress, (p) => {
      setScanning(
        p.phase === 'discovering' || p.phase === 'reading' || p.phase === 'indexing'
      )
    })
    return () => {
      unsubChanged()
      unsubProgress()
    }
  }, [queryClient])

  const query = useQuery({
    queryKey: ['songs', { search: debounced, sort, direction, format }],
    queryFn: () => getSongs({ search: debounced || null, sort, direction, format: format || null }),
    placeholderData: keepPreviousData
  })

  const attention = useQuery({
    queryKey: ['meta-attention'],
    queryFn: getNeedsAttention
  })

  const tracks = query.data?.tracks ?? []
  const attentionPaths = useMemo(
    () => new Set((attention.data ?? []).map((a) => a.path)),
    [attention.data]
  )
  const shown = attentionOnly ? tracks.filter((t) => attentionPaths.has(t.path)) : tracks
  const filtered = letter ? shown.filter((t) => letterKey(t.title) === letter) : shown
  const available = new Set(shown.map((t) => letterKey(t.title)))

  const toggleSelect = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const runFix = async (paths: string[]): Promise<void> => {
    setProgress(null)
    if (paths.length > 0) await fixMetadataMany(paths)
    setSelected(new Set())
    setFixMode(false)
    void queryClient.invalidateQueries({ queryKey: ['songs'] })
    void queryClient.invalidateQueries({ queryKey: ['meta-attention'] })
    void queryClient.invalidateQueries({ queryKey: ['artists'] })
    void queryClient.invalidateQueries({ queryKey: ['albums'] })
    void queryClient.invalidateQueries({ queryKey: ['composers'] })
  }

  const runFixAll = async (): Promise<void> => {
    setProgress(null)
    await fixAllMetadata(false)
    setSelected(new Set())
    void queryClient.invalidateQueries({ queryKey: ['songs'] })
    void queryClient.invalidateQueries({ queryKey: ['meta-attention'] })
    void queryClient.invalidateQueries({ queryKey: ['artists'] })
    void queryClient.invalidateQueries({ queryKey: ['albums'] })
    void queryClient.invalidateQueries({ queryKey: ['composers'] })
  }

  const selectedTracks = tracks.filter((t) => selected.has(t.id))

  const playTracks = usePlayer((s) => s.playTracks)

  /** Queue every visible track in random order and start from a random one. */
  const shuffleAll = (): void => {
    const pool = filtered
    const shuffled = [...pool]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    const start = Math.floor(Math.random() * shuffled.length)
    playTracks(shuffled, start, { source: 'library', sourceId: null })
  }

  return (
    <div className="flex min-h-full flex-col p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold text-ink-0">Songs</h1>
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

      <>
        <div className="mb-4 flex flex-wrap items-center justify-end gap-2">
          <button
            className="flex items-center gap-1.5 rounded-lg border border-surface-4 bg-surface-2 px-2.5 py-1.5 text-[12.5px] text-ink-2 transition-colors hover:text-ink-0 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={scanning}
            onClick={() => {
              setScanning(true)
              void rescanLibrary(false)
            }}
            title="Scan for newly added songs"
          >
            <RefreshCw size={13} className={cn(scanning && 'animate-spin')} />
            {scanning ? 'Scanning…' : 'Scan'}
          </button>
          <button
            className={cn(
              'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-40',
              fixMode && selected.size > 0
                ? 'border-accent bg-accent text-white hover:opacity-90'
                : fixMode
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-surface-4 bg-surface-2 text-ink-2 hover:text-ink-0'
            )}
            disabled={progress?.running}
            onClick={() => {
              if (fixMode) {
                if (selected.size > 0) void runFix(selectedTracks.map((t) => t.path))
                else setFixMode(false)
              } else {
                setFixMode(true)
              }
            }}
            title={
              fixMode
                ? selected.size > 0
                  ? 'Re-fetch and re-embed metadata of the selected songs'
                  : 'Cancel selection'
                : 'Select songs to re-fetch their metadata'
            }
          >
            {fixMode && selected.size === 0 && <MousePointer2 size={12} />}
            {fixMode
              ? selected.size > 0
                ? `Fix selected (${selected.size})`
                : 'Cancel'
              : 'Fix metadata'}
          </button>
          <button
            className={cn(
              'rounded-lg border px-2.5 py-1.5 text-[12.5px] transition-colors',
              attentionOnly
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-surface-4 bg-surface-2 text-ink-2 hover:text-ink-0'
            )}
            onClick={() => setAttentionOnly((v) => !v)}
            title="Songs missing cover art or composer"
          >
            Needs attention
            {attention.data && attention.data.length > 0 && (
              <span className="ml-1.5 text-[11px] opacity-70">{attention.data.length}</span>
            )}
          </button>
          <button
            className="rounded-lg border border-surface-4 bg-surface-2 px-2.5 py-1.5 text-[12.5px] text-ink-2 transition-colors hover:text-ink-0 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!attention.data || attention.data.length === 0 || progress?.running}
            onClick={() => {
              if (window.confirm(`Re-fetch metadata for all ${attention.data?.length ?? 0} songs that need it?`)) {
                void runFixAll()
              }
            }}
            title="Re-fetch metadata for every song missing cover or composer"
          >
            Fix all incomplete
          </button>
          <AlphabetFilter value={letter} onChange={setLetter} available={available} />
          <SearchBox value={filter} onChange={setFilter} placeholder="Filter tracks…" />
          <ThemedSelect
            value={format}
            onChange={setFormat}
            options={FORMATS.map((f) => [f.value, f.label] as [string, string])}
            aria-label="Filter by format"
          />
          <ThemedSelect
            value={sort}
            onChange={(v) => {
              setSort(v)
              setDirection('asc')
            }}
            options={SORTS.map((s) => [s.value, s.label] as [string, string])}
          />
          <button
            className="rounded-lg border border-surface-4 bg-surface-2 px-2.5 py-1.5 text-[12.5px] text-ink-2 hover:text-ink-0"
            onClick={() => setDirection((d) => (d === 'asc' ? 'desc' : 'asc'))}
          >
            {direction === 'asc' ? '↑' : '↓'}
          </button>
        </div>

        {progress?.running && (
          <div className="mb-2 flex items-center gap-2 text-[12px] text-ink-3">
            <Loader2 size={13} className="animate-spin" />
            Fixing metadata… {progress.done}/{progress.total}
            {progress.currentPath && (
              <span className="max-w-[40ch] truncate opacity-70">{progress.currentPath}</span>
            )}
          </div>
        )}
        {!progress?.running && progress && progress.total > 0 && progress.failed === 0 && (
          <div className="mb-2 text-[12px] text-ink-3">
            Fixed {progress.done} song(s).
          </div>
        )}
        {!progress?.running &&
          progress &&
          progress.total > 0 &&
          progress.failed > 0 &&
          progress.failures.length > 0 && (
            <div className="mb-2 rounded-xl border border-red-400/25 bg-red-500/5 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-[12.5px] font-semibold text-red-300">
                  {progress.failed} of {progress.total} songs failed
                </div>
                <button
                  className="rounded-md border border-red-400/40 bg-red-500/15 px-2.5 py-1 text-[11.5px] font-semibold text-red-200 transition-colors hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={progress.running}
                  onClick={() => void runFix(progress.failures.map((f) => f.path))}
                  title="Try these songs again"
                >
                  Retry failed ({progress.failed})
                </button>
              </div>
              <ul className="mt-2 space-y-1">
                {progress.failures.map((f) => (
                  <li key={f.path} className="flex items-baseline gap-2 text-[11.5px] text-ink-3">
                    <span className="min-w-0 flex-1 truncate" title={f.path}>
                      {basename(f.path)}
                    </span>
                    <span className="shrink-0 text-red-300/90">
                      {REASON_LABEL[f.reason ?? ''] ?? f.reason ?? 'failed'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

        {query.isFetching && !query.isLoading && (
          <div className="mb-2 flex items-center gap-2 text-[12px] text-ink-3">
            <Loader2 size={13} className="animate-spin" /> Updating…
          </div>
        )}

        <SongTable
          tracks={filtered}
          source={{ source: 'library', sourceId: null }}
          showAlbum={sort !== 'album'}
          showArtist={sort !== 'artist'}
          selectable={fixMode}
          selected={selected}
          onToggleSelect={toggleSelect}
          onShuffleAll={shuffleAll}
        />
      </>
    </div>
  )
}
