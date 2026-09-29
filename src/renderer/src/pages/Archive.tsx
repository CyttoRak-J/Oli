import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Archive as ArchiveIcon,
  ChevronLeft,
  ChevronRight,
  Download as DownloadIcon,
  ExternalLink,
  Loader2,
  Search as SearchIcon
} from 'lucide-react'
import { archiveEnqueue, archiveItem, archiveSearch, pickVideoFolder } from '../lib/ipc'
import { formatDuration, formatFileSize } from '../lib/format'
import { EmptyState } from '../components/EmptyState'
import { cn } from '../components/cn'
import { isMobileShell } from '../lib/platform'
import type { ArchiveFile, ArchiveHit } from '@shared/types'

const PAGE_SIZE = 25

const inputCls =
  'rounded-lg border border-surface-4 bg-surface-2 px-3 py-2 text-[13px] text-ink-0 outline-none focus:border-accent'

export function Archive(): React.JSX.Element {
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [lossless, setLossless] = useState(true)
  const [open, setOpen] = useState<string | null>(null)

  const results = useQuery({
    queryKey: ['archive-search', query, page, lossless],
    queryFn: () => archiveSearch(query, page, lossless),
    enabled: query.length > 0,
    staleTime: 5 * 60_000,
    retry: false
  })

  const submit = (): void => {
    const q = text.trim()
    if (!q) return
    setPage(1)
    setOpen(null)
    setQuery(q)
  }

  const total = results.data?.total ?? 0
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="mb-1 flex items-center gap-2 text-2xl font-bold text-ink-0">
        <ArchiveIcon size={22} /> Internet Archive
      </h1>
      <p className="mb-4 text-[12.5px] text-ink-3">
        Free lossless music (FLAC, WAV) from archive.org: live recordings, public-domain classics and
        Creative Commons albums. No account needed. Check each item&apos;s license before you reuse a
        recording.
      </p>

      <div className="mb-3 flex flex-col gap-2 rounded-xl border border-edge bg-surface-1 p-3 sm:flex-row">
        <input
          className={cn(inputCls, 'flex-1')}
          placeholder="Search artist, album or recording…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <label className="flex items-center gap-1.5 whitespace-nowrap text-[12.5px] text-ink-2">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-accent"
            checked={lossless}
            onChange={(e) => {
              setLossless(e.target.checked)
              setPage(1)
              setOpen(null)
            }}
          />
          Lossless only
        </label>
        <button
          className="flex items-center justify-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          disabled={!text.trim() || results.isFetching}
          onClick={submit}
        >
          {results.isFetching ? <Loader2 size={14} className="animate-spin" /> : <SearchIcon size={14} />}
          Search
        </button>
      </div>

      {!query && (
        <EmptyState
          icon={<ArchiveIcon size={36} className="mx-auto" />}
          title="Search the Internet Archive"
          description="Try a band, a composer or a concert name. Open a result to pick the format and tracks."
        />
      )}
      {query && results.isLoading && (
        <div className="flex items-center gap-2 py-6 text-[13px] text-ink-3">
          <Loader2 size={14} className="animate-spin" /> Searching…
        </div>
      )}
      {query && !results.isLoading && (results.isError || results.data?.error) && (
        <div className="rounded-lg border border-red-400/30 bg-red-500/5 px-3 py-2 text-[12.5px] text-red-300">
          {results.data?.error ?? 'Search failed.'}
          <button className="ml-2 underline hover:text-red-200" onClick={() => void results.refetch()}>
            Try again
          </button>
        </div>
      )}
      {query && results.data && !results.data.error && results.data.hits.length === 0 && (
        <div className="py-6 text-[13px] text-ink-3">
          Nothing found{lossless ? ' with lossless files' : ''}. Try other words
          {lossless ? ' or untick “Lossless only”' : ''}.
        </div>
      )}

      {results.data && results.data.hits.length > 0 && (
        <>
          <div className="mb-2 text-[12px] text-ink-3">
            {total.toLocaleString()} {total === 1 ? 'result' : 'results'}, most downloaded first
          </div>
          <div className="flex flex-col gap-2">
            {results.data.hits.map((hit) => (
              <HitRow
                key={hit.identifier}
                hit={hit}
                expanded={open === hit.identifier}
                onToggle={() => setOpen(open === hit.identifier ? null : hit.identifier)}
              />
            ))}
          </div>
          {lastPage > 1 && (
            <div className="mt-4 flex items-center justify-center gap-3 text-[12.5px] text-ink-2">
              <button
                className="flex items-center gap-1 rounded-lg border border-surface-4 bg-surface-2 px-3 py-1.5 hover:text-ink-0 disabled:opacity-40"
                disabled={page <= 1}
                onClick={() => {
                  setPage(page - 1)
                  setOpen(null)
                }}
              >
                <ChevronLeft size={14} /> Prev
              </button>
              <span className="tabular-nums">
                Page {page} of {lastPage}
              </span>
              <button
                className="flex items-center gap-1 rounded-lg border border-surface-4 bg-surface-2 px-3 py-1.5 hover:text-ink-0 disabled:opacity-40"
                disabled={page >= lastPage}
                onClick={() => {
                  setPage(page + 1)
                  setOpen(null)
                }}
              >
                Next <ChevronRight size={14} />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function HitRow({
  hit,
  expanded,
  onToggle
}: {
  hit: ArchiveHit
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-edge bg-surface-1" data-archive-id={hit.identifier}>
      <button className="flex w-full items-center gap-3 p-3 text-left" onClick={onToggle}>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-3">
          <ArchiveIcon size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-ink-0">{hit.title}</div>
          <div className="truncate text-[11.5px] text-ink-3">
            {[hit.creator, hit.year].filter(Boolean).join(' · ') || hit.identifier}
          </div>
        </div>
        <div className="shrink-0 text-[11.5px] tabular-nums text-ink-3">
          {hit.downloads.toLocaleString()} downloads
        </div>
      </button>
      {expanded && <ItemPanel hit={hit} />}
    </div>
  )
}

function ItemPanel({ hit }: { hit: ArchiveHit }): React.JSX.Element {
  const item = useQuery({
    queryKey: ['archive-item', hit.identifier],
    queryFn: () => archiveItem(hit.identifier),
    staleTime: 10 * 60_000,
    retry: false
  })
  const files = useMemo(() => item.data?.files ?? [], [item.data])

  // Formats present, best first (the service sorts files by format rank).
  const formats = useMemo(() => {
    const seen = new Map<string, { label: string; count: number }>()
    for (const f of files) {
      const cur = seen.get(f.format)
      if (cur) cur.count++
      else seen.set(f.format, { label: f.label, count: 1 })
    }
    return [...seen.entries()].map(([format, v]) => ({ format, ...v }))
  }, [files])

  const [chosenFormat, setChosenFormat] = useState<string | null>(null)
  const format = chosenFormat ?? formats[0]?.format ?? null
  const shown = useMemo(() => files.filter((f) => f.format === format), [files, format])

  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [folder, setFolder] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')

  const selected = shown.filter((f) => !excluded.has(f.name))
  const totalSize = selected.reduce((sum, f) => sum + f.size, 0)

  const toggle = (name: string): void =>
    setExcluded((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  const start = async (): Promise<void> => {
    if (selected.length === 0) return
    setBusy(true)
    setStatus('Starting…')
    try {
      const res = await archiveEnqueue(
        hit.identifier,
        selected.map((f) => f.name),
        folder.trim() || null
      )
      setStatus(
        res.enqueued > 0
          ? `Added ${res.enqueued} of ${res.found} files. See the Downloads page.`
          : 'Nothing was added'
      )
    } catch {
      setStatus('Failed to start')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t border-edge p-3">
      {item.isLoading && (
        <div className="flex items-center gap-2 py-3 text-[12.5px] text-ink-3">
          <Loader2 size={14} className="animate-spin" /> Loading files…
        </div>
      )}
      {!item.isLoading && (item.isError || item.data?.error) && (
        <div className="text-[12.5px] text-red-300">
          {item.data?.error ?? 'Could not load this item.'}
          <button className="ml-2 underline hover:text-red-200" onClick={() => void item.refetch()}>
            Try again
          </button>
        </div>
      )}
      {item.data && !item.data.error && files.length === 0 && (
        <div className="text-[12.5px] text-ink-3">This item has no audio files.</div>
      )}

      {formats.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            {formats.map((f) => (
              <button
                key={f.format}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-[11.5px] transition-colors',
                  f.format === format
                    ? 'border-accent bg-accent/15 text-accent'
                    : 'border-surface-4 bg-surface-2 text-ink-2 hover:text-ink-0'
                )}
                onClick={() => {
                  setChosenFormat(f.format)
                  setExcluded(new Set())
                }}
              >
                {f.label} ({f.count})
              </button>
            ))}
            {item.data?.licenseUrl && (
              <a
                className="ml-auto flex items-center gap-1 text-[11.5px] text-ink-3 hover:text-accent"
                href={item.data.licenseUrl}
                target="_blank"
                rel="noreferrer"
              >
                License <ExternalLink size={11} />
              </a>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-2">
            <span>
              {selected.length} of {shown.length} selected, {formatFileSize(totalSize)}
            </span>
            <button className="text-accent hover:underline" onClick={() => setExcluded(new Set())}>
              Select all
            </button>
            <button
              className="text-accent hover:underline"
              onClick={() => setExcluded(new Set(shown.map((f) => f.name)))}
            >
              Select none
            </button>
          </div>

          <div className="max-h-72 overflow-y-auto rounded-lg border border-surface-4 bg-surface-0">
            {shown.map((f) => (
              <FileRow key={f.name} file={f} on={!excluded.has(f.name)} onToggle={() => toggle(f.name)} />
            ))}
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <label className={cn('flex min-w-0 flex-1 flex-col gap-1 text-[11.5px] text-ink-3', isMobileShell() && 'hidden')}>
              Folder
              <span className="flex gap-1.5">
                <input
                  className="min-w-0 flex-1 rounded-lg border border-surface-4 bg-surface-2 px-2 py-1.5 text-[12.5px] text-ink-0 outline-none focus:border-accent"
                  placeholder="Default downloads folder"
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                />
                <button
                  className="shrink-0 rounded-lg border border-surface-4 bg-surface-2 px-2.5 py-1.5 text-[12px] text-ink-2 hover:text-ink-0"
                  onClick={() => void pickVideoFolder().then((dir) => dir && setFolder(dir))}
                >
                  Choose…
                </button>
              </span>
            </label>
            <button
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[12.5px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              disabled={busy || selected.length === 0}
              onClick={() => void start()}
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <DownloadIcon size={13} />}
              Download {selected.length > 0 ? selected.length : ''}
            </button>
          </div>
          {status && <div className="text-[12px] text-accent">{status}</div>}
        </>
      )}
    </div>
  )
}

function FileRow({
  file,
  on,
  onToggle
}: {
  file: ArchiveFile
  on: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center gap-2.5 px-2.5 py-1.5 hover:bg-surface-2',
        !on && 'opacity-50'
      )}
    >
      <input
        type="checkbox"
        className="h-3.5 w-3.5 shrink-0 accent-accent"
        checked={on}
        onChange={onToggle}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] text-ink-0">
          {file.track ? `${file.track}. ` : ''}
          {file.title ?? file.name}
        </span>
        {(file.artist || file.title) && (
          <span className="block truncate text-[11px] text-ink-3">
            {file.artist ?? file.name}
          </span>
        )}
      </span>
      {file.durationSec != null && (
        <span className="shrink-0 text-[11px] tabular-nums text-ink-3">
          {formatDuration(file.durationSec)}
        </span>
      )}
      <span className="w-16 shrink-0 text-right text-[11px] tabular-nums text-ink-3">
        {formatFileSize(file.size)}
      </span>
    </label>
  )
}
