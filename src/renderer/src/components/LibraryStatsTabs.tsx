import { NavLink } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Music, Disc3, Users, Clock3 } from 'lucide-react'
import { getStats } from '../lib/ipc'
import { formatCount, formatDuration } from '../lib/format'
import { cn } from './cn'

const LINKS = [
  { to: '/songs', label: 'Songs', icon: Music, value: (s: StatsLike) => formatCount(s?.trackCount ?? 0) },
  { to: '/albums', label: 'Albums', icon: Disc3, value: (s: StatsLike) => formatCount(s?.albumCount ?? 0) },
  { to: '/artists', label: 'Artists', icon: Users, value: (s: StatsLike) => formatCount(s?.artistCount ?? 0) }
]

interface StatsLike {
  trackCount?: number
  albumCount?: number
  artistCount?: number
  totalDuration?: number
}

export function LibraryStatsTabs(): React.JSX.Element {
  const stats = useQuery({ queryKey: ['stats'], queryFn: getStats })
  const s = stats.data

  return (
    <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
      {LINKS.map(({ to, label, icon: Icon, value }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            cn(
              'flex items-center gap-3 rounded-xl border px-3 py-2 transition-colors',
              isActive
                ? 'border-accent bg-surface-2'
                : 'border-edge bg-surface-1 hover:border-accent/50 hover:bg-surface-2'
            )
          }
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-2">
            <Icon size={18} />
          </div>
          <div className="min-w-0">
            <div className="truncate text-lg font-bold leading-none text-ink-0">
              {value(s ?? {})}
            </div>
            <div className="mt-1 text-[11px] text-ink-3">{label}</div>
          </div>
        </NavLink>
      ))}
      <div className="flex items-center gap-3 rounded-xl border border-edge bg-surface-1 px-3 py-2">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-2">
          <Clock3 size={18} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-lg font-bold leading-none text-ink-0">
            {formatDuration(s?.totalDuration ?? 0)}
          </div>
          <div className="mt-1 text-[11px] text-ink-3">Total play time</div>
        </div>
      </div>
    </div>
  )
}