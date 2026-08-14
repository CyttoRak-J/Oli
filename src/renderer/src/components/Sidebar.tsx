import { NavLink } from 'react-router-dom'
import {
  Home,
  Tags,
  Heart,
  ListMusic,
  Download,
  Settings,
  PlusCircle,
  CircleDot,
  Music2
} from 'lucide-react'
import { cn } from './cn'
import { windowControl } from '../lib/ipc'
import { usePanels } from '../store/panels'
import { Tip } from './Tip'

function Item({
  to,
  icon,
  label,
  end
}: {
  to: string
  icon: React.ReactNode
  label: string
  end?: boolean
}): React.JSX.Element {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-md px-3 py-1.5 text-[13px] font-medium text-ink-2 transition-colors',
          isActive ? 'bg-surface-2 text-ink-0' : 'hover:bg-surface-1 hover:text-ink-1'
        )
      }
    >
      {icon}
      <span>{label}</span>
    </NavLink>
  )
}

export function Sidebar(): React.JSX.Element {
  return (
    <aside className="flex w-52 shrink-0 flex-col border-r border-edge bg-surface-1">
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        <Item to="/" label="Home" icon={<Home size={16} />} end />
        <Item to="/genres" label="Genres" icon={<Tags size={16} />} />
        <Item to="/composers" label="Composers" icon={<Music2 size={16} />} />
        <Item to="/favorites" label="Favorites" icon={<Heart size={16} />} />

        <div className="px-3 pb-1 pt-4 text-[10px] font-bold uppercase tracking-widest text-ink-3">
          Browse
        </div>
        <Item to="/playlists" label="Playlists" icon={<ListMusic size={16} />} />

        <div className="px-3 pb-1 pt-4 text-[10px] font-bold uppercase tracking-widest text-ink-3">
          More
        </div>
        <Item to="/downloads" label="Downloads" icon={<Download size={16} />} />
        <Item to="/settings" label="Preferences" icon={<Settings size={16} />} />
      </nav>

      <div className="flex flex-col gap-1 border-t border-edge p-2">
        <Tip label="Open the compact mini player window">
          <button
            className="flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-[13px] font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink-0"
            onClick={() => {
              void windowControl('toggle-mini')
              void windowControl('minimize')
              usePanels.getState().open('queue')
            }}
          >
            <PlusCircle size={16} />
            <span>Mini Player</span>
          </button>
        </Tip>
        <Tip label="Open the floating bubble player on top of other apps">
          <button
            className="flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-[13px] font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink-0"
            onClick={() => {
              void windowControl('to-bubble')
              void windowControl('minimize')
              usePanels.getState().open('queue')
            }}
          >
            <CircleDot size={16} />
            <span>Bubble</span>
          </button>
        </Tip>
      </div>
    </aside>
  )
}