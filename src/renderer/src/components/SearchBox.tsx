import { useEffect, useRef } from 'react'
import { Search as SearchIcon, X } from 'lucide-react'

export function SearchBox({
  value,
  onChange,
  placeholder,
  onSearch
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  /** Called with the trimmed query when the user pauses typing or presses Enter. */
  onSearch?: (v: string) => void
}): React.JSX.Element {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const fire = (v: string): void => {
    const t = v.trim()
    if (t.length >= 2) onSearch?.(t)
  }

  return (
    <div className="relative">
      <SearchIcon
        size={14}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"
      />
      <input
        className="w-56 rounded-full border border-surface-4 bg-surface-2 py-1.5 pl-8 pr-8 text-[12.5px] text-ink-0 outline-none focus:border-accent"
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          if (timerRef.current) clearTimeout(timerRef.current)
          timerRef.current = setTimeout(() => fire(e.target.value), 350)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            if (timerRef.current) clearTimeout(timerRef.current)
            fire(value)
          }
        }}
      />
      {value && (
        <button
          className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink-0"
          onClick={() => onChange('')}
          aria-label="Clear search"
        >
          <X size={13} />
        </button>
      )}
    </div>
  )
}
