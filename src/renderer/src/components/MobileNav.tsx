import { NavLink } from 'react-router-dom'
import { Archive, Download, Home, Music, Settings } from 'lucide-react'
import { cn } from './cn'

const ITEMS = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/songs', label: 'Songs', icon: Music, end: false },
  { to: '/archive', label: 'Archive', icon: Archive, end: false },
  { to: '/downloads', label: 'Downloads', icon: Download, end: false },
  { to: '/settings', label: 'Settings', icon: Settings, end: false }
]

/** Bottom navigation for the phone layout (replaces the desktop sidebar). */
export function MobileNav(): React.JSX.Element {
  return (
    <nav className="flex shrink-0 items-stretch justify-around border-t border-edge bg-surface-1 pb-[env(safe-area-inset-bottom)]">
      {ITEMS.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            cn(
              'flex flex-1 flex-col items-center gap-0.5 py-2 text-[10.5px] font-medium transition-colors',
              isActive ? 'text-accent' : 'text-ink-2'
            )
          }
        >
          <Icon size={19} />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  )
}
