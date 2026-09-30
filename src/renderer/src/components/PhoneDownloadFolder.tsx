import { useCallback, useEffect, useState } from 'react'
import { getDownloadPlugin } from '../platform/downloadQueue'
import { getMediaPlugin } from '../platform/phoneLibrary'

interface RootInfo {
  root: string
  custom?: string
  allFiles?: boolean
}

/** Phone: where downloads are saved (Settings > Downloads), chosen with Android's folder picker like the library folder. */
export default function PhoneDownloadFolder(): React.JSX.Element | null {
  const dl = getDownloadPlugin()
  const media = getMediaPlugin()
  const [info, setInfo] = useState<RootInfo | null>(null)
  const [note, setNote] = useState('')

  const refresh = useCallback((): void => {
    void dl?.getRoot().then(setInfo).catch(() => undefined)
  }, [dl])
  useEffect(() => {
    refresh()
    // coming back from Android's "all files access" page
    const onShow = (): void => refresh()
    document.addEventListener('visibilitychange', onShow)
    return () => document.removeEventListener('visibilitychange', onShow)
  }, [refresh])

  if (!dl || !media) return null
  const custom = info?.custom ?? ''
  const waiting = custom !== '' && info?.allFiles === false

  const choose = async (): Promise<void> => {
    setNote('')
    try {
      const picked = await media.pickFolder()
      if (picked.cancelled || picked.path === undefined) return
      const r = await dl.setRoot({ volume: picked.volume, path: picked.path })
      setInfo(r)
      if (r.allFiles === false) {
        setNote('Allow "access to all files" for Oli on the next screen, then come back.')
        await dl.requestAllFiles()
      }
    } catch (e) {
      setNote(String((e as { message?: string } | null)?.message ?? e))
    }
  }

  const reset = async (): Promise<void> => {
    setNote('')
    setInfo(await dl.setRoot({ reset: true }))
  }

  return (
    <div className="mb-4 flex flex-col gap-2">
      <div className="text-[12.5px] text-ink-1">Download folder</div>
      <div className="select-text break-all text-[12px] text-ink-2">{info ? info.root : '…'}</div>
      {waiting && (
        <div className="text-[12px] text-amber-400">
          {custom} is chosen but Android has not allowed access to all files yet: downloads still go to the app folder.
        </div>
      )}
      {note && <div className="text-[12px] text-ink-2">{note}</div>}
      <div className="flex gap-2">
        <button
          onClick={() => void choose()}
          className="rounded-md border border-surface-4 bg-surface-2 px-3 py-1.5 text-[12.5px] text-ink-1"
        >
          Choose folder
        </button>
        {waiting && (
          <button
            onClick={() => void dl.requestAllFiles()}
            className="rounded-md border border-surface-4 bg-surface-2 px-3 py-1.5 text-[12.5px] text-ink-1"
          >
            Allow access
          </button>
        )}
        {custom !== '' && (
          <button
            onClick={() => void reset()}
            className="rounded-md border border-surface-4 bg-surface-2 px-3 py-1.5 text-[12.5px] text-ink-2"
          >
            Use default
          </button>
        )}
      </div>
    </div>
  )
}
