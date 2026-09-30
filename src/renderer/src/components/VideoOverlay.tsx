import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { buildVideoPage, type VideoQualitySet } from '@shared/videoPage'

interface VideoEvent {
  videoId: string
  set: VideoQualitySet
}

/**
 * Phone: the PC's video window as a full-screen layer. It is the same page (picture + sound, quality list, repeat, speed,
 * volume, download panel), shown in an iframe that shares the app's bridge so its Download buttons use the phone's queue.
 */
export function VideoOverlay(): React.JSX.Element | null {
  const [page, setPage] = useState<string | null>(null)

  useEffect(() => {
    const open = (e: Event): void => {
      void (async () => {
        const { videoId, set } = (e as CustomEvent<VideoEvent>).detail
        // hls.js is only loaded when a stream of this video needs it
        let hls = ''
        if (set.streams.some((s) => s.hls)) {
          try {
            const src = (await import('hls.js/dist/hls.min.js?raw')).default
            hls = `<script>${src.split('</script').join('<' + String.fromCharCode(92) + '/script')}</script>`
          } catch {
            hls = ''
          }
        }
        setPage(buildVideoPage(set, videoId, `<script>window.cytto=parent.cytto</script>${hls}`))
      })()
    }
    const close = (): void => setPage(null)
    window.addEventListener('oli:video', open)
    window.addEventListener('oli:video-close', close)
    return () => {
      window.removeEventListener('oli:video', open)
      window.removeEventListener('oli:video-close', close)
    }
  }, [])

  useEffect(() => {
    const w = window as unknown as { __oliVideoOpen?: boolean }
    w.__oliVideoOpen = page !== null
    return () => {
      w.__oliVideoOpen = false
    }
  }, [page])

  if (page === null) return null
  return (
    <div className="fixed inset-0 z-[200] bg-black">
      <iframe title="Video" srcDoc={page} allow="autoplay; fullscreen" allowFullScreen className="h-full w-full border-0" />
      <button
        aria-label="Close video"
        className="absolute left-2 top-2 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white"
        onClick={() => setPage(null)}
      >
        <X size={20} />
      </button>
    </div>
  )
}
