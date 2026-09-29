import { useEffect } from 'react'
import { NavLink } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { IPC } from '@shared/ipc'
import type { DownloadItem } from '@shared/types'
import { getDownloads, on } from '../lib/ipc'
import { usePanels } from '../store/panels'
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
  // The red number on the Downloads icon: files waiting or downloading right now.
  const queryClient = useQueryClient()
  const downloads = useQuery({ queryKey: ['downloads'], queryFn: getDownloads })
  useEffect(
    () =>
      on<DownloadItem[]>(IPC.onDownloadsChanged, (list) => {
        if (Array.isArray(list)) queryClient.setQueryData(['downloads'], list)
      }),
    [queryClient]
  )
  const running = (downloads.data ?? []).filter((d) => d.state === 'queued' || d.state === 'downloading').length

  return (
    <nav className="flex shrink-0 items-stretch justify-around border-t border-edge bg-surface-1 pb-[env(safe-area-inset-bottom)]">
      {ITEMS.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          // tapping the tab of the page you are already on must also uncover it
          onClick={() => usePanels.getState().close()}
          className={({ isActive }) =>
            cn(
              'flex flex-1 flex-col items-center gap-0.5 py-2 text-[10.5px] font-medium transition-colors',
              isActive ? 'text-accent' : 'text-ink-2'
            )
          }
        >
          <span className="relative">
            <Icon size={19} />
            {to === '/downloads' && running > 0 && (
              <span
                className="absolute -right-2.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9.5px] font-bold leading-none text-white"
                aria-label={`${running} downloading`}
              >
                {running > 99 ? '99+' : running}
              </span>
            )}
          </span>
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  )
}
