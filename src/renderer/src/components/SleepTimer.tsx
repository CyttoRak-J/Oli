import { useEffect, useState } from 'react'
import { Moon } from 'lucide-react'
import { useSleepTimer } from '../store/sleepTimer'
import { ThemedSelect } from './ThemedSelect'

const PRESETS: Array<[string, string]> = [
  ['off', 'Off'],
  ['15', '15 min'],
  ['30', '30 min'],
  ['45', '45 min'],
  ['60', '60 min'],
  ['90', '90 min']
]

function formatRemaining(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function SleepTimer(): React.JSX.Element {
  const endAt = useSleepTimer((s) => s.endAt)
  const start = useSleepTimer((s) => s.start)
  const cancel = useSleepTimer((s) => s.cancel)
  const remainingSeconds = useSleepTimer((s) => s.remainingSeconds)
  const [, forceTick] = useState(0)

  useEffect(() => {
    if (endAt === null) return
    const id = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [endAt])

  return (
    <div className="flex items-center gap-1.5">
      <Moon size={13} className="text-ink-3" />
      <ThemedSelect
        value={endAt === null ? 'off' : 'active'}
        options={endAt === null ? PRESETS : [['active', formatRemaining(remainingSeconds())], ['off', 'Cancel']]}
        onChange={(v) => {
          if (v === 'off') {
            cancel()
          } else if (v !== 'active') {
            start(Number(v))
          }
        }}
      />
    </div>
  )
}
