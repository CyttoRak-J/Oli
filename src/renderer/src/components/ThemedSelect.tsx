import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from './cn'

export function ThemedSelect({
  value,
  onChange,
  options,
  className
}: {
  value: string
  onChange: (v: string) => void
  options: Array<[string, string]>
  className?: string
}): React.JSX.Element {
  const current = options.find(([v]) => v === value)
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className={cn(
            'flex items-center gap-1.5 rounded-lg border border-surface-4 bg-surface-2 px-2.5 py-1.5 text-[12.5px] text-ink-0 outline-none focus:border-accent',
            className
          )}
          aria-label="Select option"
        >
          {current?.[1] ?? value}
          <ChevronDown size={12} className="text-ink-3" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="z-50 min-w-[160px] rounded-lg border border-edge bg-surface-2 p-1 shadow-2xl"
          sideOffset={4}
          align="start"
        >
          {options.map(([v, label]) => (
            <DropdownMenu.Item
              key={v}
              className="flex cursor-default items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-[12.5px] text-ink-1 outline-none transition-colors hover:bg-surface-3 hover:text-ink-0 data-[highlighted]:bg-surface-3 data-[highlighted]:text-ink-0"
              onSelect={() => onChange(v)}
            >
              <span>{label}</span>
              {v === value && <Check size={13} className="text-accent" />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
