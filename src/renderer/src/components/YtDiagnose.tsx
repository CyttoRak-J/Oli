import { useState } from 'react'
import { getYouTubePlugin } from '../platform/youtubeService'

/** Phone: asks YouTube for a known video with each method and reports which parts of the file are served (for support). */
export default function YtDiagnose(): React.JSX.Element | null {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const plugin = getYouTubePlugin()
  if (!plugin) return null
  const run = (): void => {
    setBusy(true)
    setText('Testing… (up to two minutes)')
    void (
      plugin as unknown as { diagnose(o: { videoId: string }): Promise<{ text: string }> }
    )
      .diagnose({ videoId: 'uA2d7HZkqO4' })
      .then((r) => setText(r.text))
      .catch((e: unknown) => setText('Test failed: ' + String((e as { message?: string } | null)?.message ?? e)))
      .finally(() => setBusy(false))
  }
  return (
    <div className="mt-3 flex flex-col gap-2">
      <button
        disabled={busy}
        onClick={run}
        className="self-start rounded-md border border-surface-4 bg-surface-2 px-3 py-1.5 text-[12.5px] text-ink-1 disabled:opacity-60"
      >
        Test video access
      </button>
      {text && <pre className="select-text whitespace-pre-wrap break-words text-[11px] text-ink-2">{text}</pre>}
    </div>
  )
}
