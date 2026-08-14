import { Clock, History as HistoryIcon, Pin, X } from 'lucide-react'
import { cn } from './cn'
import { EmptyState } from './EmptyState'

export interface HistoryEntry {
  id: string
  query: string
  pinned: boolean
  createdAt: number
}

export function HistoryPanel({
  items,
  onRemove,
  onPin,
  onClear,
  onPick
}: {
  items: HistoryEntry[]
  onRemove: (id: string) => void
  onPin: (id: string, pinned: boolean) => void
  onClear: () => void
  onPick: (q: string) => void
}): React.JSX.Element {
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<HistoryIcon size={36} className="mx-auto" />}
        title="Search history"
        description="Recent searches appear here. Try searching an artist, album or title."
      />
    )
  }
  return (
    <div className="max-w-xl">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-ink-3">
          <HistoryIcon size={14} /> Recent searches
        </div>
        <button className="text-[11.5px] text-ink-3 hover:text-red-400" onClick={onClear}>
          Clear all
        </button>
      </div>
      <div className="flex flex-col gap-0.5">
        {items.map((h) => (
          <div key={h.id} className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-1">
            <button
              className="flex flex-1 items-center gap-2 text-left text-[13px] text-ink-1 group-hover:text-ink-0"
              onClick={() => onPick(h.query)}
            >
              <Clock size={13} className="text-ink-3" />
              <span className="truncate">{h.query}</span>
            </button>
            <button
              className={cn('p-1 text-ink-3 hover:text-ink-0', h.pinned && 'text-accent')}
              onClick={() => onPin(h.id, h.pinned)}
              aria-label="Pin search"
            >
              <Pin size={13} />
            </button>
            <button className="p-1 text-ink-3 hover:text-red-400" onClick={() => onRemove(h.id)} aria-label="Remove">
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
