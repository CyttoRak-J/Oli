import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Download as DownloadIcon,
  Pause,
  Play,
  X,
  RotateCw,
  RefreshCw,
  FolderOpen,
  Trash2,
  Plus,
  Loader2,
  AlertTriangle,
  ArrowUp,
  ArrowDownToLine
} from 'lucide-react'
import { IPC } from '@shared/ipc'
import { Tip } from '../components/Tip'
import {
  getDownloads,
  pauseDownload,
  resumeDownload,
  cancelDownload,
  retryDownload,
  clearCompletedDownloads,
  clearPendingDownloads,
  revealDownload,
  enqueueDownload,
  pauseAllDownloads,
  resumeAllDownloads,
  removeDownload,
  fixMetadata,
  on
} from '../lib/ipc'
import { EmptyState } from '../components/EmptyState'
import { LinkDownloadForm } from '../components/LinkDownloadForm'
import { detectYtInput } from '../lib/linkDetect'
import { formatEta, formatFileSize } from '../lib/format'
import type { DetectedLink } from '../lib/linkDetect'
import type { DownloadItem } from '@shared/types'

export function Downloads(): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [enqueueing, setEnqueueing] = useState(false)
  const [ytForm, setYtForm] = useState<DetectedLink | null>(null)

  const downloads = useQuery({
    queryKey: ['downloads'],
    queryFn: getDownloads,
    refetchInterval: (query) => {
      const items = query.state.data
      const active = items?.some((d) => d.state === 'downloading' || d.state === 'queued') ?? false
      return active ? 2000 : false
    }
  })

  useEffect(() => {
    const unsub = on<unknown>(IPC.onDownloadsChanged, () => void downloads.refetch())
    return unsub
  }, [downloads])

  const items = downloads.data ?? []
  const pendingCount = items.filter(
    (d) => d.state === 'queued' || d.state === 'downloading' || d.state === 'paused'
  ).length

  const submit = async (): Promise<void> => {
    if (!url.trim()) return
    const yt = detectYtInput(url.trim())
    if (yt) {
      setYtForm(yt)
      setUrl('')
      setTitle('')
      return
    }
    setEnqueueing(true)
    try {
      await enqueueDownload(url.trim(), title.trim())
      setUrl('')
      setTitle('')
    } catch {
      // keep the URL so the user can retry; the button must never stick
    } finally {
      setEnqueueing(false)
    }
    void downloads.refetch()
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="mb-4 flex items-center gap-2 text-2xl font-bold text-ink-0">
        <DownloadIcon size={22} /> Downloads
      </h1>

      <div className="mb-6 flex flex-col gap-2 rounded-xl border border-edge bg-surface-1 p-3 sm:flex-row">
        <input
          className="flex-1 rounded-lg border border-surface-4 bg-surface-2 px-3 py-2 text-[13px] text-ink-0 outline-none focus:border-accent"
          placeholder="https://… track URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <input
          className="flex-1 rounded-lg border border-surface-4 bg-surface-2 px-3 py-2 text-[13px] text-ink-0 outline-none focus:border-accent"
          placeholder="Title (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button
          className="flex items-center justify-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          disabled={!url.trim() || enqueueing}
          onClick={() => void submit()}
        >
          {enqueueing ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          Add
        </button>
      </div>

      {ytForm && (
        <div className="mb-6">
          <LinkDownloadForm
            key={ytForm.kind === 'playlist' ? ytForm.playlistUrl : ytForm.videoId}
            link={ytForm}
            onEnqueued={() => void downloads.refetch()}
            onClose={() => setYtForm(null)}
          />
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState
          icon={<DownloadIcon size={36} className="mx-auto" />}
          title="No downloads"
          description="Paste a URL above to download a track, or remove completed items once you finish."
        />
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex justify-end gap-2 pb-1">
            {pendingCount > 0 && (
              <button
                className="flex items-center gap-1.5 rounded-lg border border-surface-4 bg-surface-2 px-3 py-1.5 text-[12px] text-ink-2 hover:border-red-400/60 hover:text-red-300"
                onClick={() => {
                  if (window.confirm(`Cancel and remove ${pendingCount} pending download(s)? No files were saved yet.`)) {
                    void clearPendingDownloads().then(() => downloads.refetch())
                  }
                }}
              >
                <X size={13} /> Cancel pending ({pendingCount})
              </button>
            )}
            {items.some((d) => d.state === 'downloading' || d.state === 'queued') && (
              <button
                className="flex items-center gap-1.5 rounded-lg border border-surface-4 bg-surface-2 px-3 py-1.5 text-[12px] text-ink-2 hover:text-ink-0"
                onClick={() => void pauseAllDownloads().then(() => downloads.refetch())}
              >
                <Pause size={13} /> Pause all
              </button>
            )}
            {items.some((d) => d.state === 'paused') && (
              <button
                className="flex items-center gap-1.5 rounded-lg border border-surface-4 bg-surface-2 px-3 py-1.5 text-[12px] text-ink-2 hover:text-accent"
                onClick={() => void resumeAllDownloads().then(() => downloads.refetch())}
              >
                <Play size={13} /> Resume all
              </button>
            )}
            <button
              className="flex items-center gap-1.5 rounded-lg border border-surface-4 bg-surface-2 px-3 py-1.5 text-[12px] text-ink-2 hover:border-red-400/60 hover:text-red-300"
              onClick={() => void clearCompletedDownloads().then(() => downloads.refetch())}
            >
              <Trash2 size={13} /> Clear completed
            </button>
          </div>
          {items.map((d) => (
            <DownloadRow key={d.id} item={d} onChanged={() => void downloads.refetch()} />
          ))}
        </div>
      )}
      {items.length > 0 && <CornerButtons items={items} />}
    </div>
  )
}

const CORNER_BTN_CLS =
  'pointer-events-auto flex h-8 w-8 items-center justify-center rounded-lg border border-edge bg-surface-2 text-ink-2 shadow-md shadow-black/25 transition-colors hover:border-accent hover:text-ink-0 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-edge disabled:hover:text-ink-2'

function CornerButtons({ items }: { items: DownloadItem[] }): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const activeId =
    items.find((d) => d.state === 'downloading')?.id ??
    items.find((d) => d.state === 'queued')?.id ??
    null

  const scrollParent = (): HTMLElement => {
    let node: HTMLElement | null = wrapRef.current
    while (node) {
      const style = getComputedStyle(node)
      if (node.scrollHeight > node.clientHeight && /(auto|scroll|overlay)/.test(style.overflowY)) {
        return node
      }
      node = node.parentElement
    }
    return document.documentElement
  }

  const toTop = (): void => {
    scrollParent().scrollTo({ top: 0, behavior: 'smooth' })
  }

  const toCurrent = (): void => {
    if (!activeId) return
    const el = scrollParent().querySelector<HTMLElement>(`[data-download-id="${activeId}"]`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.remove('list-jump-flash')
    void el.offsetWidth
    el.classList.add('list-jump-flash')
  }

  return (
    <div ref={wrapRef} className="pointer-events-none sticky bottom-3 z-30 flex justify-end gap-1.5">
      <Tip label="Scroll to top">
        <button className={CORNER_BTN_CLS} onClick={toTop} aria-label="Scroll to top">
          <ArrowUp size={14} />
        </button>
      </Tip>
      <Tip label={activeId ? 'Go to current download' : 'No active download'}>
        <button
          className={CORNER_BTN_CLS}
          onClick={toCurrent}
          disabled={!activeId}
          aria-label="Go to current download"
        >
          <ArrowDownToLine size={14} />
        </button>
      </Tip>
    </div>
  )
}

function DownloadRow({
  item,
  onChanged
}: {
  item: DownloadItem
  onChanged: () => void
}): React.JSX.Element {
  const active = item.state === 'downloading' || item.state === 'queued'
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [fixing, setFixing] = useState(false)
  const [fixError, setFixError] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const doFix = async (): Promise<void> => {
    setFixing(true)
    setFixError(null)
    try {
      const res = await fixMetadata(item.destPath)
      if (!res.ok) setFixError(res.reason ?? 'failed')
      void queryClient.invalidateQueries({ queryKey: ['songs'] })
      void queryClient.invalidateQueries({ queryKey: ['meta-attention'] })
    } catch (e) {
      setFixError(e instanceof Error ? e.message : String(e))
    }
    setFixing(false)
  }

  return (
    <div data-download-id={item.id} className="rounded-xl border border-edge bg-surface-1 p-3">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-3">
          <DownloadIcon size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-ink-0">{item.title}</div>
          <div className="flex items-center gap-2 text-[11.5px] text-ink-3">
            <StateBadge state={item.state} />
            {item.state === 'completed' && item.missing && (
              <span className="rounded bg-amber-500/10 px-1.5 py-0.5 font-medium text-amber-400">
                file missing
              </span>
            )}
            {item.error && <span className="truncate text-red-400">{item.error}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {item.state === 'downloading' && (
            <IconButton onClick={() => void pauseDownload(item.id).then(onChanged)} label="Pause">
              <Pause size={14} className="fill-current" />
            </IconButton>
          )}
          {item.state === 'paused' && (
            <IconButton onClick={() => void resumeDownload(item.id).then(onChanged)} label="Resume">
              <Play size={14} className="fill-current" />
            </IconButton>
          )}
          {(item.state === 'queued' || item.state === 'downloading' || item.state === 'paused') && (
            <IconButton onClick={() => void cancelDownload(item.id).then(onChanged)} label="Cancel">
              <X size={14} />
            </IconButton>
          )}
          {item.state === 'failed' && (
            <IconButton onClick={() => void retryDownload(item.id).then(onChanged)} label="Retry">
              <RotateCw size={14} />
            </IconButton>
          )}
          {(item.state === 'completed' || item.state === 'failed' || item.state === 'canceled') && (
            <IconButton onClick={() => void revealDownload(item.id)} label="Reveal">
              <FolderOpen size={14} />
            </IconButton>
          )}
          {item.state === 'completed' && (
            <IconButton
              onClick={() => void doFix()}
              label={fixing ? 'Fixing metadata…' : 'Re-fetch metadata'}
            >
              {fixing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            </IconButton>
          )}
          <IconButton
            onClick={() => setConfirmRemove(true)}
            label="Remove"
          >
            <Trash2 size={14} />
          </IconButton>
        </div>
        <div className="flex items-center gap-1.5 whitespace-nowrap text-[11.5px] tabular-nums text-ink-3">
          {item.totalBytes != null && item.totalBytes > 0 ? (
            <>
              <span>{Math.round(item.progress * 100)}%</span>
              <span className="text-ink-2">{formatFileSize(item.downloadedBytes)} / {formatFileSize(item.totalBytes)}</span>
            </>
          ) : (
            <span>{formatFileSize(item.downloadedBytes)}</span>
          )}
          {item.state === 'downloading' && item.speed > 0 && (
            <span className="text-ink-2">{formatFileSize(item.speed)}/s</span>
          )}
          {item.state === 'downloading' && formatEta(item.etaSeconds) && (
            <span>{formatEta(item.etaSeconds)}</span>
          )}
        </div>
      </div>
      {active && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-3">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300"
            style={{ width: `${Math.round(item.progress * 100)}%` }}
          />
        </div>
      )}
      {fixError && (
        <div className="mt-2 text-[11.5px] text-red-400">Fix failed: {fixError}</div>
      )}
      {confirmRemove && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-300">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="flex-1">
            {item.state === 'downloading' || item.state === 'queued' ? (
              <>
                Remove <span className="font-medium text-amber-200">{item.title}</span> from the
                list? The download is still running — canceling it will leave a partial file on disk.
              </>
            ) : (
              <>
                Remove <span className="font-medium text-amber-200">{item.title}</span> from the
                list? Delete the downloaded file as well?
              </>
            )}
          </span>
          <button
            className="rounded-md bg-red-500/90 px-2.5 py-1 text-[11.5px] font-semibold text-white hover:bg-red-500"
            onClick={() => {
              setConfirmRemove(false)
              void removeDownload(item.id, true).then(onChanged)
            }}
          >
            {item.state === 'downloading' || item.state === 'queued'
              ? 'Cancel &amp; delete file'
              : 'Delete row &amp; file'}
          </button>
          <button
            className="rounded-md border border-surface-4 bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-1 hover:text-ink-0"
            onClick={() => {
              setConfirmRemove(false)
              void removeDownload(item.id).then(onChanged)
            }}
          >
            Keep file
          </button>
          <button
            className="rounded-md px-2 py-1 text-[11.5px] text-ink-3 hover:text-ink-0"
            onClick={() => setConfirmRemove(false)}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}

function StateBadge({ state }: { state: DownloadItem['state'] }): React.JSX.Element {
  const map: Record<DownloadItem['state'], string> = {
    queued: 'text-ink-3',
    downloading: 'text-accent',
    paused: 'text-ink-3',
    completed: 'text-green-400',
    failed: 'text-red-400',
    canceled: 'text-ink-3'
  }
  return <span className={map[state]}>{state}</span>
}

function IconButton({
  children,
  onClick,
  label
}: {
  children: React.ReactNode
  onClick: () => void
  label: string
}): React.JSX.Element {
  return (
    <button
      className="flex h-7 w-7 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink-0"
      onClick={onClick}
      aria-label={label}
    >
      {children}
    </button>
  )
}