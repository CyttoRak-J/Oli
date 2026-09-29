import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Download, Loader2, X } from 'lucide-react'
import { IPC } from '@shared/ipc'
import { getYtEngineStatus, installYtEngine, on } from '../lib/ipc'
import type { YtEngineStatus } from '@shared/types'

/**
 * Tells the user when the YouTube engine (yt-dlp) is missing, does not run, is
 * outdated, or was just installed, and offers the fix. With "update
 * automatically" on, the app does the install itself and this only reports it.
 */
export function YtEngineBanner(): React.JSX.Element | null {
  const [status, setStatus] = useState<YtEngineStatus | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [doneText, setDoneText] = useState<string | null>(null)
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let alive = true
    void getYtEngineStatus()
      .then((s) => alive && setStatus(s))
      .catch(() => undefined)
    const off = on<YtEngineStatus>(IPC.onYtEngineStatus, (s) => {
      setStatus(s)
      // A finished install is announced for a few seconds, then the banner goes away.
      if (s.state === 'ok' && s.message) {
        setDoneText(s.message)
        if (doneTimer.current) clearTimeout(doneTimer.current)
        doneTimer.current = setTimeout(() => setDoneText(null), 6000)
      }
    })
    return () => {
      alive = false
      off()
      if (doneTimer.current) clearTimeout(doneTimer.current)
    }
  }, [])

  if (!status) return null
  const key = `${status.state}:${status.latest ?? ''}`
  const cls = 'flex flex-wrap items-center gap-2 border-b px-4 py-2 text-[12.5px]'
  const btn =
    'flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-[12px] font-semibold text-white hover:opacity-90'
  const link = 'rounded-md px-2 py-1 text-[12px] text-ink-2 hover:text-ink-0'
  const settingUp = (status.state === 'missing' || status.state === 'broken') && status.auto

  if (status.state === 'installing' || settingUp) {
    return (
      <div className={`${cls} border-edge bg-surface-1 text-ink-1`} role="status">
        <Loader2 size={14} className="animate-spin text-accent" />
        {status.state === 'installing'
          ? 'Installing the YouTube engine (yt-dlp)…'
          : 'Setting up the YouTube engine (yt-dlp)…'}
      </div>
    )
  }
  if (status.state === 'missing' || status.state === 'broken') {
    return (
      <div className={`${cls} border-amber-500/30 bg-amber-500/10 text-amber-200`} role="alert">
        <AlertTriangle size={14} className="shrink-0" />
        <span className="flex-1">
          {status.state === 'missing'
            ? 'The YouTube engine (yt-dlp) is missing, so YouTube search, playback and downloads will not work. Your library and Internet Archive still work.'
            : 'The YouTube engine (yt-dlp) is installed but does not run (an antivirus may have blocked it), so YouTube features will not work.'}
        </span>
        <button className={btn} onClick={() => void installYtEngine()}>
          <Download size={13} /> {status.state === 'missing' ? 'Install now' : 'Reinstall'}
        </button>
      </div>
    )
  }
  if (status.state === 'failed') {
    if (dismissed === key) return null
    return (
      <div className={`${cls} border-red-400/30 bg-red-500/10 text-red-200`} role="alert">
        <AlertTriangle size={14} className="shrink-0" />
        <span className="flex-1">Could not set up the YouTube engine: {status.message ?? 'unknown error'}</span>
        <button className={btn} onClick={() => void installYtEngine()}>
          Try again
        </button>
        <button className={link} onClick={() => setDismissed(key)} aria-label="Dismiss">
          <X size={14} />
        </button>
      </div>
    )
  }
  if (status.state === 'update-available') {
    if (dismissed === key) return null
    return (
      <div className={`${cls} border-edge bg-surface-1 text-ink-1`} role="status">
        <Download size={14} className="shrink-0 text-accent" />
        <span className="flex-1">
          {status.message ??
            `A newer YouTube engine is available (${status.version ?? '?'} to ${status.latest ?? '?'}).`}
        </span>
        <button className={btn} onClick={() => void installYtEngine()}>
          Update now
        </button>
        <button className={link} onClick={() => setDismissed(key)}>
          Later
        </button>
      </div>
    )
  }
  if (status.state === 'ok' && doneText) {
    return (
      <div className={`${cls} border-edge bg-surface-1 text-ink-1`} role="status">
        <Check size={14} className="text-green-400" /> {doneText}
      </div>
    )
  }
  return null
}
