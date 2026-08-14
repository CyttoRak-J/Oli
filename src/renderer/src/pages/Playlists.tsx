import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import * as Dialog from '@radix-ui/react-dialog'
import {
  getPlaylists,
  createPlaylist,
  deletePlaylist,
  duplicatePlaylist,
  togglePlaylistPin,
  importPlaylist
} from '../lib/ipc'
import { ListMusic, Plus, X, Pin, Copy, Trash2, Sparkles } from 'lucide-react'
import { formatDuration } from '../lib/format'
import { cn } from '../components/cn'
import { EmptyState } from '../components/EmptyState'
import { AlphabetFilter, letterKey } from '../components/AlphabetFilter'
import { SearchBox } from '../components/SearchBox'
import { search as runSearch } from '../lib/ipc'

export function Playlists(): React.JSX.Element {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const playlists = useQuery({ queryKey: ['playlists'], queryFn: getPlaylists })
  const [createOpen, setCreateOpen] = useState(false)
  const [onlineSearch, setOnlineSearch] = useState('')
  const [filter, setFilter] = useState('')
  const [letter, setLetter] = useState<string | null>(null)

  const list = (playlists.data ?? [])
    .filter((p) => !filter.trim() || p.name.toLowerCase().includes(filter.trim().toLowerCase()))
    .filter((p) => !letter || letterKey(p.name) === letter)
    .slice()
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name))

  const remove = async (id: string): Promise<void> => {
    await deletePlaylist(id)
    qc.invalidateQueries({ queryKey: ['playlists'] })
  }

  return (
    <div className="p-6">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold text-ink-0">Playlists</h1>
        <div className="flex flex-wrap items-center gap-2">
          <SearchBox
            value={onlineSearch}
            onChange={setOnlineSearch}
            placeholder="Search online…"
            onSearch={(v) => {
              void runSearch(v, undefined, true)
              navigate(`/search?q=${encodeURIComponent(v)}`)
            }}
          />
          <button
            className="rounded-lg border border-surface-4 bg-surface-2 px-3 py-1.5 text-[12.5px] text-ink-1 hover:border-accent"
            onClick={() => void importPlaylist().then(() => qc.invalidateQueries({ queryKey: ['playlists'] }))}
          >
            Import
          </button>
          <button
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-white hover:opacity-90"
            onClick={() => setCreateOpen(true)}
          >
            <Plus size={14} /> New playlist
          </button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <AlphabetFilter
          value={letter}
          onChange={setLetter}
          available={new Set((playlists.data ?? []).map((p) => letterKey(p.name)))}
        />
        <SearchBox value={filter} onChange={setFilter} placeholder="Filter playlists…" />
      </div>

      {playlists.data?.length === 0 ? (
        <EmptyState
          icon={<ListMusic size={40} className="mx-auto" />}
          title="No playlists yet"
          description="Create a playlist to group tracks your way, or import an .m3u file."
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {list.map((p) => (
          <div
            key={p.id}
            className="group relative flex items-center gap-3 rounded-xl border border-edge bg-surface-1 p-3 transition-colors hover:border-surface-4"
          >
            <Link to={`/playlists/${p.id}`} className="flex min-w-0 flex-1 items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-surface-2 text-ink-2">
                {p.type === 'smart' ? <Sparkles size={18} /> : <ListMusic size={18} />}
              </div>
              <div className="min-w-0">
                <div className="truncate text-[13.5px] font-semibold text-ink-0 group-hover:text-accent">
                  {p.name}
                </div>
                <div className="text-[11.5px] text-ink-3">
                  {p.trackCount} {p.trackCount === 1 ? 'track' : 'tracks'}
                  {p.totalDuration ? ` · ${formatDuration(p.totalDuration)}` : ''}
                </div>
              </div>
            </Link>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                className="rounded-md p-1.5 text-ink-3 hover:bg-surface-3 hover:text-ink-0"
                onClick={() => void togglePlaylistPin(p.id).then(() => qc.invalidateQueries({ queryKey: ['playlists'] }))}
                title={p.pinned ? 'Unpin' : 'Pin'}
              >
                <Pin size={14} className={cn(p.pinned && 'fill-accent text-accent')} />
              </button>
              <button
                className="rounded-md p-1.5 text-ink-3 hover:bg-surface-3 hover:text-ink-0"
                onClick={() => void duplicatePlaylist(p.id).then(() => qc.invalidateQueries({ queryKey: ['playlists'] }))}
                title="Duplicate"
              >
                <Copy size={14} />
              </button>
              <button
                className="rounded-md p-1.5 text-ink-3 hover:bg-surface-3 hover:text-red-400"
                onClick={() => void remove(p.id)}
                title="Delete"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
        </div>
      )}

      <CreateDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  )
}

function CreateDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}): React.JSX.Element {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async (): Promise<void> => {
    if (!name.trim()) return
    setBusy(true)
    await createPlaylist({ name: name.trim(), description: desc.trim() })
    setBusy(false)
    setName('')
    setDesc('')
    qc.invalidateQueries({ queryKey: ['playlists'] })
    onOpenChange(false)
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,400px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-edge bg-surface-2 p-4 shadow-2xl outline-none">
          <div className="mb-3 flex items-center justify-between">
            <Dialog.Title className="text-[15px] font-semibold text-ink-0">New playlist</Dialog.Title>
            <Dialog.Close asChild>
              <button className="text-ink-3 hover:text-ink-0" aria-label="Close">
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>
          <label className="mb-3 block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-ink-3">Name</span>
            <input
              autoFocus
              className="w-full rounded-lg border border-surface-4 bg-surface-3 px-3 py-2 text-[13px] text-ink-0 outline-none focus:border-accent"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void save()}
              placeholder="My playlist"
            />
          </label>
          <label className="mb-4 block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-ink-3">Description</span>
            <input
              className="w-full rounded-lg border border-surface-4 bg-surface-2 px-3 py-2 text-[13px] text-ink-0 outline-none focus:border-accent"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
            />
          </label>
          <button
            className="w-full rounded-lg bg-accent py-2 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
            disabled={busy || !name.trim()}
            onClick={() => void save()}
          >
            Create
          </button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}