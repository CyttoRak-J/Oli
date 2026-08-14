import { useEffect, useState } from 'react'
import { Minus, Square, Copy, X } from 'lucide-react'
import { getWindowState, windowControl } from '../lib/ipc'

export function TitleBar(): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void getWindowState().then((s) => setMaximized(s.maximized))
    const onResize = (): void => {
      // window 'resize' gives a rough signal; re-query on interval while open
    }
    window.addEventListener('resize', onResize)
    const timer = setInterval(() => {
      void getWindowState().then((s) => setMaximized(s.maximized))
    }, 1500)
    return () => {
      window.removeEventListener('resize', onResize)
      clearInterval(timer)
    }
  }, [])

  return (
    <div className="app-region-drag flex h-10 shrink-0 items-center justify-between border-b border-edge bg-surface-1 pl-4">
      <div className="flex items-center gap-2 text-[13px] font-semibold tracking-wide text-ink-1">
        <span className="flex h-4 w-4 items-center justify-center rounded-sm bg-accent text-[9px] font-black text-white">
          𑀧
        </span>
        <span>Oli</span>
      </div>

      <div className="app-region-no-drag flex h-full">
        <button
          className="flex h-full w-11 items-center justify-center text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink-0"
          onClick={() => void windowControl('minimize')}
          aria-label="Minimize"
        >
          <Minus size={15} />
        </button>
        <button
          className="flex h-full w-11 items-center justify-center text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink-0"
          onClick={() => void windowControl('maximize')}
          aria-label="Maximize"
        >
          {maximized ? <Copy size={13} /> : <Square size={12} />}
        </button>
        <button
          className="flex h-full w-11 items-center justify-center text-ink-2 transition-colors hover:bg-red-600 hover:text-white"
          onClick={() => void windowControl('close')}
          aria-label="Close"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  )
}