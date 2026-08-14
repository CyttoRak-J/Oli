import { cn } from './cn'

const LETTERS = [
  '#',
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'I',
  'J',
  'K',
  'L',
  'M',
  'N',
  'O',
  'P',
  'Q',
  'R',
  'S',
  'T',
  'U',
  'V',
  'W',
  'X',
  'Y',
  'Z'
]

/** Bucket a name into its alphabet key: A–Z or '#' for anything non-letter. */
export function letterKey(name: string): string {
  const c = (name ?? '').trim().charAt(0)
  if (!c) return ''
  const u = c.toUpperCase()
  return /^[A-Z]$/.test(u) ? u : '#'
}

export interface AlphabetFilterProps {
  value: string | null
  onChange: (v: string | null) => void
  /** Letters that actually exist in the current list; others are dimmed. */
  available?: Set<string>
}

export function AlphabetFilter({
  value,
  onChange,
  available
}: AlphabetFilterProps): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-0.25">
      {LETTERS.map((l) => {
        const active = value === l
        const exists = available == null || available.has(l)
        return (
          <button
            key={l}
            onClick={() => onChange(active ? null : l)}
            disabled={!exists}
            title={exists ? `Filter by ${l}` : `No items start with ${l}`}
            aria-label={`Filter by ${l}`}
            className={cn(
              'flex h-6 min-w-6 items-center justify-center rounded-md px-1 text-[11px] font-semibold transition-colors',
              active
                ? 'bg-accent text-white'
                : 'text-ink-2 hover:bg-surface-2 hover:text-ink-0',
              !exists && 'cursor-default opacity-30'
            )}
          >
            {l}
          </button>
        )
      })}
    </div>
  )
}
