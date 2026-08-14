import { useEffect, useRef, useState } from 'react'
import { IPC } from '@shared/ipc'
import { Artwork } from '../components/Artwork'
import {
  bubbleReveal,
  getPlaybackState,
  getSongById,
  moveWindowBy,
  on,
  snapBubble,
  windowControl
} from '../lib/ipc'
import { useSettings } from '../store/settings'
import type { PlaybackState, Track } from '@shared/types'

interface DragState {
  active: boolean
  moved: boolean
  startX: number
  startY: number
  lastX: number
  lastY: number
  accumX: number
  accumY: number
}

export function Bubble(): React.JSX.Element {
  const [state, setState] = useState<PlaybackState | null>(null)
  const [trackCache, setTrackCache] = useState<Record<string, Track | null>>({})
  const bubbleOpacity = useSettings((s) => s.settings?.miniPlayerOpacity ?? 1)
  const dragRef = useRef<DragState>({
    active: false,
    moved: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    accumX: 0,
    accumY: 0
  })
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    // The bubble window is transparent; keep the page from painting over it.
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    let disposed = false
    void getPlaybackState().then((s) => {
      if (!disposed) setState(s)
    })
    const unsub = on<PlaybackState>(IPC.onPlaybackState, (s) => setState(s))
    const interval = setInterval(() => {
      if (disposed) return
      void getPlaybackState().then((s) => setState(s))
    }, 15000)
    void useSettings.getState().load()
    const offSettings = useSettings.getState().subscribe()
    return () => {
      disposed = true
      unsub()
      clearInterval(interval)
      offSettings()
    }
  }, [])

  const songId = state?.songId ?? null

  useEffect(() => {
    if (!songId) return
    let disposed = false
    if (!(songId in trackCache)) {
      void getSongById(songId).then((t) => {
        if (!disposed) setTrackCache((m) => ({ ...m, [songId]: t }))
      })
    }
    return () => {
      disposed = true
    }
  }, [songId, trackCache])

  const track = songId == null ? null : (trackCache[songId] ?? null)
  const displayTrack = track ?? {
    id: songId ?? '',
    artworkUrl: state?.artworkUrl ?? null,
    title: state?.title ?? '',
    artist: state?.artist ?? ''
  }

  /** Send any pointer deltas not yet flushed, keeping fast drags from losing distance. */
  const flushPending = (): void => {
    const d = dragRef.current
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (d.accumX !== 0 || d.accumY !== 0) {
      const x = d.accumX
      const y = d.accumY
      d.accumX = 0
      d.accumY = 0
      void moveWindowBy(x, y)
    }
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    // A docked bubble peeks half off-screen; slide fully in as the drag starts.
    void bubbleReveal()
    dragRef.current = {
      active: true,
      moved: false,
      startX: e.screenX,
      startY: e.screenY,
      lastX: e.screenX,
      lastY: e.screenY,
      accumX: 0,
      accumY: 0
    }
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const d = dragRef.current
    if (!d.active) return
    d.accumX += e.screenX - d.lastX
    d.accumY += e.screenY - d.lastY
    d.lastX = e.screenX
    d.lastY = e.screenY
    if (Math.abs(e.screenX - d.startX) + Math.abs(e.screenY - d.startY) > 4) {
      d.moved = true
    }
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      const pending = { x: d.accumX, y: d.accumY }
      d.accumX = 0
      d.accumY = 0
      if (pending.x !== 0 || pending.y !== 0) {
        void moveWindowBy(pending.x, pending.y)
      }
    })
  }

  const endDrag = (e: React.PointerEvent): void => {
    const d = dragRef.current
    if (!d.active) return
    d.active = false
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    if (d.moved) {
      flushPending()
      void snapBubble()
    } else {
      void windowControl('to-mini')
    }
  }

  const isPlaying = state?.status === 'playing'

  return (
    <div
      className="group h-full w-full cursor-grab active:cursor-grabbing"
      style={{ touchAction: 'none', opacity: bubbleOpacity, transition: 'opacity 200ms ease' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      title={track ? `${track.title} — ${track.artist}` : `${displayTrack.title} — ${displayTrack.artist}`}
    >
      <div className="bubble-cd relative h-full w-full shadow-lg shadow-black/60 ring-1 ring-white/15">
        <div
          className={isPlaying ? 'bubble-spin absolute inset-0' : 'bubble-spin bubble-spin-paused absolute inset-0'}
          style={{ animationPlayState: isPlaying ? 'running' : 'paused' }}
        >
          <Artwork
            songId={displayTrack.id}
            hasEmbedded={track?.hasEmbeddedArtwork}
            artworkUrl={displayTrack.artworkUrl ?? undefined}
            label={`${displayTrack.title} ${displayTrack.artist}`}
            fluid
            muted
            rounded="rounded-full"
            className="h-full w-full opacity-80 transition-transform duration-150 group-hover:scale-105 group-hover:opacity-100"
          />
        </div>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-[13%] w-[13%] rounded-full bg-black/80 shadow-inner ring-1 ring-white/20" />
        </div>
      </div>
    </div>
  )
}
