import { useCallback, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X, Plus } from 'lucide-react'
import type { Playlist, Track } from '@shared/types'
import { getPlaylists, createPlaylist, addToPlaylist } from '../lib/ipc'
import { useQueryClient } from '@tanstack/react-query'

export function AddToPlaylistDialog({
  open,
  onOpenChange,
  tracks
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tracks: Track[]
}): React.JSX.Element {
  const qc = useQueryClient()
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  const load = useCallback(async () => {
    const list = await getPlaylists().catch(() => [])
    setPlaylists(list)
    setSelected(Object.fromEntries(list.map((p) => [p.id, false])))
  }, [])

  function handleOpenChange(open: boolean): void {
    if (open) {
      void load()
    } else {
      setDone(false)
      setBusy(false)
      setNewName('')
    }
    onOpenChange(open)
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    const ids = Object.entries(selected)
      .filter(([, v]) => v)
      .map(([id]) => id)
    const target = tracks.map((t) => t.id)
    for (const id of ids) {
      await addToPlaylist(id, target)
    }
    if (newName.trim()) {
      const pl = await createPlaylist({ name: newName.trim() })
      if (pl) await addToPlaylist(pl.id, target)
    }
    setBusy(false)
    setDone(true)
    qc.invalidateQueries({ queryKey: ['playlists'] })
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,420px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-edge bg-surface-2 p-4 shadow-2xl outline-none">
          <div className="mb-3 flex items-center justify-between">
            <Dialog.Title className="text-[15px] font-semibold text-ink-0">
              Add {tracks.length} track{tracks.length === 1 ? '' : 's'} to playlist
            </Dialog.Title>
            <Dialog.Close asChild>
              <button className="text-ink-3 hover:text-ink-0" aria-label="Close">
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          {done ? (
            <div className="py-6 text-center text-[13px] text-ink-1">Added to playlist.</div>
          ) : (
            <>
              <div className="mb-3 max-h-56 space-y-1 overflow-y-auto pr-1">
                <label className="flex items-center gap-2 rounded-md bg-surface-3 px-3 py-2">
                  <input
                    type="checkbox"
                    className="accent-accent"
                    onChange={(e) => setNewName(e.target.checked ? ' ' : '')}
                  />
                  <input
                    className="flex-1 bg-transparent text-[13px] text-ink-0 outline-none placeholder:text-ink-3"
                    placeholder="Name a new playlist…"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                  />
                </label>
                {playlists.map((p) => (
                  <label
                    key={p.id}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-[13px] text-ink-1 hover:bg-surface-3"
                  >
                    <input
                      type="checkbox"
                      className="accent-accent"
                      checked={Boolean(selected[p.id])}
                      onChange={(e) =>
                        setSelected((s) => ({ ...s, [p.id]: e.target.checked }))
                      }
                    />
                    <span className="truncate">{p.name}</span>
                    <span className="ml-auto text-ink-3">{p.trackCount}</span>
                  </label>
                ))}
              </div>
              <button
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                disabled={busy}
                onClick={() => void save()}
              >
                <Plus size={16} />
                {busy ? 'Adding…' : 'Add'}
              </button>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}