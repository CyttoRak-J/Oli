import { X, Keyboard } from 'lucide-react'
import { SHORTCUTS } from '../lib/useGlobalShortcuts'

export function ShortcutsPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[380px] max-w-[92vw] rounded-xl border border-edge bg-surface-1 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-[14px] font-bold text-ink-0">
            <Keyboard size={16} /> Keyboard Shortcuts
          </div>
          <button
            className="rounded-md p-1 text-ink-3 hover:bg-surface-2 hover:text-ink-0"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex flex-col gap-1.5">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="flex items-center justify-between text-[12.5px]">
              <span className="text-ink-2">{s.description}</span>
              <kbd className="rounded-md border border-surface-4 bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-ink-1">
                {s.keys}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
