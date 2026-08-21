import { create } from 'zustand'
import type { PlaybackState, Track } from '@shared/types'
import { needsTranscodeFor } from '@shared/constants'
import {
  sendPlaybackState,
  saveQueue,
  getQueue,
  getSettings,
  setSettings,
  getSongById,
  clearQueue as clearQueueIPC,
  transcodeLocalFile,
  probeDuration,
  resolveYouTubeStream,
  resolveDownloadYouTubeAudio
} from '../lib/ipc'
import { clamp } from '../lib/format'

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended'
export type RepeatMode = 'off' | 'queue' | 'one'

let audio: HTMLAudioElement | null = null

/** Renderer-side debug log (forwarded to the app log via console-message). */
const dbg = (...args: unknown[]): void => {
  try {
    console.log('[player]', ...args)
  } catch {
    // ignore
  }
}

const srcHost = (el: HTMLAudioElement): string => {
  try {
    const u = new URL(el.src)
    return u.hostname.slice(0, 28) || '(none)'
  } catch {
    return '(none)'
  }
}

function getAudio(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio()
    audio.preload = 'auto'
  }
  return audio
}

/** Ordered fallback stream URLs for the currently loaded track. */
let streamFallbacks: string[] = []
let streamFallbackIdx = 0

/** Track id we already tried to transcode (prevents infinite retry loops). */
let transcodedTrackId: string | null = null

/** Track ids for which we already tried the local download fallback. */
const ytDownloadAttempted = new Set<string>()

/** Track id whose transcode is currently in flight (swallows duplicate errors). */
let transcodeInFlight: string | null = null

let stallTimer: ReturnType<typeof setTimeout> | null = null

function clearStall(): void {
  if (stallTimer) {
    clearTimeout(stallTimer)
    stallTimer = null
  }
}

/**
 * Seek position the user clicked while an online track played. Streams often
 * error or re-buffer after a seek, so fallback URLs / re-resolved streams
 * restore this position once their metadata loads (the song then continues
 * from where the user clicked instead of restarting or skipping).
 */
let pendingSeekPos = 0
let lastSeekAt = 0
/** When the user resumed from pause; fresh re-buffers get grace time before the stall watchdog may restart/skip the song. */
let resumedAt = 0
/** hydrate() attaches listeners to the singleton audio element; guard against
 *  double attachment (React StrictMode double-mounts effects in dev). */
let listenersAttached = false

export interface PlaySource {
  source: 'library' | 'playlist' | 'album' | 'artist' | 'queue' | 'search' | 'favorites' | 'downloads'
  sourceId: string | null
}

interface PlayerState {
  queue: Track[]
  index: number
  current: Track | null
  status: PlayerStatus
  currentTime: number
  duration: number
  volume: number
  muted: boolean
  shuffle: boolean
  repeat: RepeatMode
  source: PlaySource
  /** Queue indices in the order they were actually played (top = current). */
  history: number[]

  hydrate: () => Promise<void>
  playTracks: (tracks: Track[], startIndex: number, source: PlaySource) => void
  playTrack: (track: Track, source?: PlaySource) => void
  addToQueue: (track: Track) => void
  playNext: (track: Track) => void
  toggle: () => void
  pause: () => void
  play: () => void
  next: (auto?: boolean) => void
  previous: () => void
  seek: (seconds: number) => void
  setVolume: (volume: number) => void
  toggleMute: () => void
  toggleShuffle: () => void
  cycleRepeat: () => void
  removeFromQueue: (id: string) => void
  clearQueue: () => void
  patchTrack: (id: string, patch: Partial<Track>) => void
  stop: () => void
}

function makeSnapshot(s: PlayerState): Partial<PlaybackState> {
  return {
    songId: s.current?.id ?? null,
    status: s.status,
    currentTime: s.currentTime,
    duration: s.duration,
    volume: s.volume,
    muted: s.muted,
    shuffle: s.shuffle,
    repeat: s.repeat,
    positionMeta: { queueIndex: s.index, queueLength: s.queue.length },
    timestamp: Date.now(),
    title: s.current?.title ?? null,
    artist: s.current?.artist ?? null,
    artworkUrl: s.current?.artworkUrl ?? null
  }
}

function persistQueue(queue: Track[]): void {
  void saveQueue(queue.map((t) => ({ id: t.id, songId: t.id, via: null, track: t })))
}

let volumePersistTimer: ReturnType<typeof setTimeout> | null = null

function persistVolume(volume: number): void {
  if (volumePersistTimer) clearTimeout(volumePersistTimer)
  volumePersistTimer = setTimeout(() => void setSettings({ volume }), 300)
}

export const usePlayer = create<PlayerState>((set, get) => {
  let lastSyncAt = 0

  const syncMain = (): void => {
    const now = Date.now()
    if (now - lastSyncAt < 500) return
    lastSyncAt = now
    sendPlaybackState(makeSnapshot(get()))
  }

  const syncMainNow = (): void => {
    lastSyncAt = 0
    syncMain()
  }

  /** Cap so a long listening session cannot grow memory unboundedly. */
  const HISTORY_LIMIT = 300

  /** Record that `idx` became the current track (top of the history). */
  const pushHistory = (idx: number): void => {
    if (idx < 0) return
    set((s) => {
      const h = s.history
      if (h[h.length - 1] === idx) return {}
      const next = h.length >= HISTORY_LIMIT ? h.slice(h.length - HISTORY_LIMIT + 1) : h
      return { history: [...next, idx] }
    })
  }

  /** Start a fresh play context; the given track is the only history. */
  const resetHistory = (idx: number): void => set({ history: idx >= 0 ? [idx] : [] })

  const load = (track: Track): void => {
    const el = getAudio()
    clearStall()
    transcodedTrackId = null
    streamFallbacks = []
    streamFallbackIdx = 0
    set({ current: track, status: 'loading', currentTime: 0, duration: 0 })
    // YouTube tracks are never played from stored URLs (they expire and
    // stall unpredictably): a FRESH stream is resolved at play time, every
    // time, in any quality/format, with the local download as fallback.
    if (track.id.startsWith('youtube:') && !track.path) {
      freshResolveOnline(track)
      return
    }
    // Local file (or an online track already downloaded earlier in session).
    el.src = `cyttos-local://file/${encodeURIComponent(track.path)}`
    // Chromium cannot decode some formats (e.g. opus); when the DB has no
    // duration, ask main to probe it with ffprobe so the UI never shows 0:00.
    if (track.duration <= 0) {
      void probeDuration(track.path).then((d) => {
        const s = get()
        if (d && s.current?.id === track.id && s.duration <= 0) set({ duration: d })
      })
    }
    // Eager transcode: if a cached MP3 exists (pre-transcoded during scans),
    // swap to it immediately; otherwise it warms the cache in the background
    // while the original file tries to play.
    if (needsTranscodeFor(track.codec, track.path)) {
      transcodeInFlight = track.id
      void transcodeLocalFile(track.path).then((mp3) => {
        if (transcodeInFlight === track.id) transcodeInFlight = null
        const s = get()
        if (s.current?.id !== track.id) return
        if (mp3 && s.status === 'loading') {
          clearStall()
          el.src = `cyttos-local://file/${encodeURIComponent(mp3)}`
          el.play().catch((e: Error) => dbg(`play() rejected: ${e.message}`))
        }
        // When null, the original file plays if possible; otherwise the
        // stall timer / error handler triggers tryTranscode as a retry.
      })
    }
    // If Chromium cannot decode the file it may stall instead of erroring;
    // fall back to transcoding if nothing starts within 6 seconds. A seek or
    // resume right after load (slow drives take a while to re-buffer) gets
    // one more window instead of being skipped.
    stallTimer = setTimeout(() => {
      const s = get()
      if (s.status !== 'loading' || s.current?.id !== track.id) return
      if (!tryTranscode()) {
        if (Date.now() - lastSeekAt < 10000 || Date.now() - resumedAt < 10000) {
          clearStall()
          stallTimer = setTimeout(() => {
            const s2 = get()
            if (s2.status === 'loading' && s2.current?.id === track.id && !tryTranscode()) {
              skipCurrent()
            }
          }, 15000)
          return
        }
        skipCurrent()
      }
    }, 6000)
  }

  /** Online track currently resolving a fresh stream (guards dual attempts). */
  let freshResolvingId: string | null = null

  /** YouTube video id of a track, or '' when the track is not online. */
  const videoIdOf = (track: Track): string =>
    track.id.startsWith('youtube:') ? track.id.slice('youtube:'.length) : ''

  /**
   * Resolve a YouTube track at play time: fresh direct stream first (m4a/AAC
   * preferred at the source), then a local download, then any pre-resolved
   * URLs the track may already carry. Works for EVERY format and quality
   * YouTube offers — expired/stale queued URLs never matter.
   */
  const freshResolveOnline = (track: Track): void => {
    const videoId = videoIdOf(track)
    const done = (): void => {
      clearStall()
      if (get().current?.id === track.id) skipCurrent()
    }
    if (!videoId) {
      done()
      return
    }
    // Streams resolved when the song was picked are seconds old: play them
    // immediately instead of resolving again (a second yt-dlp round is slow
    // and can fail on transient bot checks). Fresh re-resolution only
    // happens as a fallback when these URLs fail.
    if (track.streamUrls && track.streamUrls.length > 0) {
      streamFallbacks = track.streamUrls.slice(1)
      streamFallbackIdx = 0
      const el = getAudio()
      el.src = track.streamUrls[0]
      dbg(`play-pre-resolved url#0 of ${track.streamUrls.length}; fb=${streamFallbacks.length}`)
      el.play().catch((e: Error) => dbg(`play() rejected (pre-resolved): ${e.message}`))
      return
    }
    freshResolvingId = track.id
    const stillCurrent = (): boolean => get().current?.id === track.id
    void (async () => {
      try {
        // Resolve fresh, with one retry: transient yt-dlp hiccups (bot
        // checks, rate limits) are common and usually succeed on retry.
        let urls: string[] = []
        for (let attempt = 0; attempt < 2 && urls.length === 0; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 1200))
          if (!stillCurrent()) return
          urls = await resolveYouTubeStream(videoId).catch(() => [] as string[])
        }
        if (!stillCurrent()) return
        if (urls.length > 0) {
          streamFallbacks = urls.slice(1)
          streamFallbackIdx = 0
          const el = getAudio()
          el.src = urls[0]
          dbg(`play-fresh-resolve url#0 of ${urls.length}`)
          el.play().catch((e: Error) => dbg(`play() rejected (fresh): ${e.message}`))
          return
        }
        // No playable stream URLs: download the audio with yt-dlp (works
        // for EVERY format) and play it through the local-file pipeline.
        const file = await resolveDownloadYouTubeAudio(videoId).catch(() => null as string | null)
        if (!stillCurrent()) return
        if (file) {
          load({ ...track, path: file, streamUrl: undefined, streamUrls: [], missing: false, codec: null })
          return
        }
        done()
      } catch {
        done()
      } finally {
        if (freshResolvingId === track.id) freshResolvingId = null
      }
    })()
  }

  /**
   * Last-resort playback for online tracks whose stream failed: download the
   * audio with yt-dlp to a local temp file (works for EVERY YouTube format)
   * and play it through the local-file pipeline. Downloads are cached in
   * main for the session, so repeat plays are instant. Returns false when
   * the track is not eligible (not a YouTube id, or already attempted).
   */
  const startOnlineFallback = (track: Track): boolean => {
    if (!track.id.startsWith('youtube:') || ytDownloadAttempted.has(track.id)) return false
    if (freshResolvingId === track.id) return true
    ytDownloadAttempted.add(track.id)
    dbg(`online-fallback: downloading audio for ${track.id}`)
    const videoId = videoIdOf(track)
    if (!videoId) return false
    clearStall()
    set({ status: 'loading' })
    void resolveDownloadYouTubeAudio(videoId)
      .then(async (file) => {
        if (get().current?.id !== track.id) return 'moved'
        if (file) {
          dbg('online-fallback: playing downloaded audio file')
          load({ ...track, path: file, streamUrl: undefined, streamUrls: [], missing: false, codec: null })
          return 'played'
        }
        // Download fell through (transient bot checks etc.): one final fresh
        // stream resolution can still save the song.
        const urls = await resolveYouTubeStream(videoId).catch(() => [] as string[])
        if (get().current?.id !== track.id) return 'moved'
        if (urls.length > 0) {
          load({ ...track, streamUrl: urls[0], streamUrls: urls })
          return 'played'
        }
        return 'failed'
      })
      .then((result) => {
        if (result !== 'failed') return
        clearStall()
        if (get().current?.id === track.id) skipCurrent()
      })
      .catch(() => {
        clearStall()
        if (get().current?.id === track.id) skipCurrent()
      })
    return true
  }

  /** Transcode an unplayable local file to MP3 and keep playing it. */
  const tryTranscode = (): boolean => {
    const s = get()
    const cur = s.current
    if (!cur || cur.streamUrl || !cur.path) return false
    if (transcodeInFlight === cur.id) return true
    if (transcodedTrackId === cur.id) return false
    transcodedTrackId = cur.id
    transcodeInFlight = cur.id
    clearStall()
    set({ status: 'loading' })
    void transcodeLocalFile(cur.path).then((mp3) => {
      if (transcodeInFlight === cur.id) transcodeInFlight = null
      const el = getAudio()
      // The user may have moved on while transcoding; never hijack playback.
      if (get().current?.id !== cur.id) return
      if (mp3) {
        el.src = `cyttos-local://file/${encodeURIComponent(mp3)}`
        el.play().catch((e: Error) => dbg(`play() rejected: ${e.message}`))
      } else {
        skipCurrent()
      }
    })
    return true
  }

  /** Skip the current track (or stop when the queue is empty). */
  const skipCurrent = (): void => {
    const s = get()
    if (s.queue.length > 0) {
      set({ status: 'ended' })
      get().next(true)
    } else {
      set({ status: 'idle' })
      syncMainNow()
    }
  }

  /**
   * Stall recovery: a stream that starves mid-track (common with opus) never
   * fires an error, so after a wait the playback falls back to a transcode /
   * download or skips. A SEEK or RESUME starts a fresh re-buffer that can
   * take a while on slow media (USB/network drives): while the user is
   * driving the track, the song must never be restarted from 0 or skipped.
   */
  const stallWatchdog = (): void => {
    const s = get()
    const elNow = getAudio()
    if (s.status !== 'loading') return
    if (elNow.paused) return
    const cur = s.current
    if (!cur) return
    const sinceSeek = Date.now() - lastSeekAt
    const sinceResume = Date.now() - resumedAt
    const userDriven = sinceSeek < 60000 || sinceResume < 60000
    if (userDriven) {
      if (sinceSeek < 30000 || sinceResume < 30000) {
        // Inside the grace window: keep waiting, never hijack.
        stallTimer = setTimeout(stallWatchdog, 20000)
        return
      }
      // Past the grace window and still stalled: the stream is dead. Fall
      // back WITHOUT skipping — reloads restore the seek position.
      if (cur.path) {
        if (!tryTranscode() && transcodedTrackId === cur.id) {
          // The transcoded MP3 also stalls: wait once more instead of skip.
          stallTimer = setTimeout(stallWatchdog, 30000)
        }
      } else if (!startOnlineFallback(cur)) {
        // Download fallback already attempted: the track's URLs may be
        // stale — resolve a fresh stream before ever skipping.
        const videoId = videoIdOf(cur)
        if (videoId && freshResolvingId !== cur.id) {
          freshResolvingId = cur.id
          void resolveYouTubeStream(videoId)
            .then((urls) => {
              if (freshResolvingId === cur.id) freshResolvingId = null
              if (urls.length === 0) return
              if (get().current?.id !== cur.id) return
              const el = getAudio()
              el.src = urls[0]
              el.play().catch((e: Error) => dbg(`play() rejected: ${e.message}`))
            })
            .catch(() => {
              if (freshResolvingId === cur.id) freshResolvingId = null
            })
        }
      }
      return
    }
    // No user action: normal starvation fallback, skip only as last resort.
    if (cur.path) {
      if (!tryTranscode()) skipCurrent()
    } else if (!startOnlineFallback(cur)) {
      skipCurrent()
    }
  }

  return {
    queue: [],
    index: -1,
    current: null,
    status: 'idle',
    currentTime: 0,
    duration: 0,
    volume: 0.8,
    muted: false,
    shuffle: false,
    repeat: 'off',
    source: { source: 'library', sourceId: null },
    history: [],

    async hydrate(): Promise<void> {
      const el = getAudio()
      const queue = await getQueue().catch(() => [])
      if (queue.length > 0) {
        const tracks = queue.map((e) => e.track).filter(Boolean)
        set({ queue: tracks, index: 0, history: [0] })
      }

      // Restore volume, shuffle and repeat from saved settings.
      const settings = await getSettings().catch(() => null)
      if (settings) {
        const volume = clamp(Number(settings.volume ?? 0.8), 0, 1)
        el.volume = volume
        set({ volume })
        if (typeof settings.shuffle === 'boolean') set({ shuffle: settings.shuffle })
        if (settings.repeat === 'off' || settings.repeat === 'queue' || settings.repeat === 'one') {
          set({ repeat: settings.repeat })
        }
      } else {
        el.volume = 0.8
      }

      if (listenersAttached) return
      listenersAttached = true

      el.addEventListener('timeupdate', () => {
        const s = get()
        if (s.status === 'playing') {
          set({ currentTime: el.currentTime })
          syncMain()
        }
      })
      el.addEventListener('loadedmetadata', () => {
        const real = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0
        if (!get().current?.path) dbg(`loadedmetadata dur=${real} host=${srcHost(el)}`)
        set({ duration: real || get().duration })
        // The track object (queue rows, player bar) may carry no duration
        // yet (YouTube search results); backfill it with the real value.
        if (real > 0) get().patchTrack(get().current?.id ?? '', { duration: real })
        // Restore the position the user clicked: fallback streams after a
        // failed seek start from where the user wanted instead of 0.
        if (pendingSeekPos > 0 && el.duration && pendingSeekPos < el.duration) {
          try {
            el.currentTime = pendingSeekPos
          } catch {
            // ignore
          }
        }
      })
      el.addEventListener('play', () => {
        if (!get().current?.path) dbg(`play-event fired (${srcHost(el)})`)
        set({ status: 'playing' })
        syncMainNow()
      })
      el.addEventListener('pause', () => {
        clearStall()
        // Remember where the user stopped: if playback must be reloaded after
        // resume (transcode / download fallback), it continues from here
        // instead of restarting from 0.
        const cur = get().current
        const t = el.currentTime
        if (cur && t > 0 && (!el.duration || t < el.duration) && pendingSeekPos === 0) {
          pendingSeekPos = t
        }
        set({ status: 'paused' })
        syncMainNow()
      })
      el.addEventListener('waiting', () => {
        if (!get().current?.path) dbg(`waiting (${srcHost(el)})`)
        set({ status: 'loading' })
        clearStall()
        // A seek or a resume-from-pause starts a fresh re-buffer; the
        // watchdog gives those a long grace window (it would otherwise
        // restart or skip the song on slow media).
        const userDriven = Date.now() - lastSeekAt < 3000 || Date.now() - resumedAt < 3000
        stallTimer = setTimeout(stallWatchdog, userDriven ? 20000 : 10000)
        syncMainNow()
      })
      el.addEventListener('playing', () => {
        if (!get().current?.path) dbg(`playing-event fired (${srcHost(el)})`)
        clearStall()
        pendingSeekPos = 0
        lastSeekAt = 0
        set({ status: 'playing' })
        syncMainNow()
      })
      el.addEventListener('ended', () => get().next(true))
      el.addEventListener('error', () => {
        clearStall()
        const failed = get().current
        // Removing the src attribute (queue edits, stop) fires a spurious
        // MEDIA_ERR_SRC_NOT_SUPPORTED error event with no current track; with
        // a null current the fallback chain must not start or skip anything.
        if (!failed) return
        if (!failed.path) {
          dbg(`audio-error code=${el.error?.code} idx=${streamFallbackIdx} fbs=${streamFallbacks.length} host=${srcHost(el)}`)
        }
        if (streamFallbackIdx + 1 < streamFallbacks.length) {
          streamFallbackIdx += 1
          const next = streamFallbacks[streamFallbackIdx]
          set({ status: 'loading' })
          // A short delay lets Chromium finish aborting the failed source;
          // switching instantly can surface spurious format errors.
          setTimeout(() => {
            el.src = next
            el.play().catch((e: Error) => dbg(`play() rejected: ${e.message}`))
          }, 300)
          return
        }
        streamFallbacks = []
        streamFallbackIdx = 0
        // Online tracks have no local file to transcode: go through the
        // stream re-resolve / download fallback instead of being skipped.
        if (!failed.path && startOnlineFallback(failed)) return
        if (tryTranscode()) return
        // Last chance for online tracks whose download fallback was already
        // attempted this session: the URLs they carry may be stale/expired
        // (replays via previous/queue) — resolve a fresh stream before skip.
        if (!failed.path) {
          const videoId = videoIdOf(failed)
          if (videoId && freshResolvingId !== failed.id) {
            freshResolvingId = failed.id
            set({ status: 'loading' })
            void resolveYouTubeStream(videoId)
              .then((urls) => {
                if (freshResolvingId === failed.id) freshResolvingId = null
                if (urls.length === 0) {
                  skipCurrent()
                  return
                }
                if (get().current?.id !== failed.id) return
                const elNow = getAudio()
                elNow.src = urls[0]
                elNow.play().catch((e: Error) => dbg(`play() rejected: ${e.message}`))
              })
              .catch(() => {
                if (freshResolvingId === failed.id) freshResolvingId = null
                skipCurrent()
              })
            return
          }
        }
        skipCurrent()
      })
    },

    playTracks(tracks, startIndex, source): void {
      if (tracks.length === 0) return
      const idx = clamp(startIndex, 0, tracks.length - 1)
      const track = tracks[idx]
      pendingSeekPos = 0
      lastSeekAt = 0
      set({ queue: tracks, index: idx, current: track, source })
      resetHistory(idx)
      load(track)
      getAudio().play().catch((e: Error) => dbg(`play() rejected: ${e.message}`))
      persistQueue(tracks)
      sendPlaybackState(makeSnapshot(get()))
    },

    playTrack(track, source = { source: 'library', sourceId: null }): void {
      const s = get()
      const idx = s.queue.findIndex((t) => t.id === track.id)
      if (idx !== -1) {
        set({ index: idx })
        pushHistory(idx)
        pendingSeekPos = 0
        lastSeekAt = 0
        load(track)
        getAudio().play().catch((e: Error) => dbg(`play() rejected: ${e.message}`))
        sendPlaybackState(makeSnapshot(get()))
        return
      }
      get().playTracks([track], 0, source)
    },

    addToQueue(track): void {
      const s = get()
      if (s.queue.some((t) => t.id === track.id)) return
      const queue = [...s.queue, track]
      set({ queue })
      persistQueue(queue)
      sendPlaybackState(makeSnapshot(get()))
    },

    /** Insert a track right after the current one so it plays next. */
    playNext(track): void {
      const s = get()
      if (s.queue.some((t) => t.id === track.id)) return
      const at = s.current && s.index >= 0 ? s.index + 1 : s.queue.length
      const queue = [...s.queue.slice(0, at), track, ...s.queue.slice(at)]
      set({ queue })
      persistQueue(queue)
      sendPlaybackState(makeSnapshot(get()))
    },

    toggle(): void {
      const s = get()
      if (s.status === 'playing') {
        getAudio().pause()
      } else if (s.current) {
        if (s.status === 'paused') resumedAt = Date.now()
        getAudio().play().catch((e: Error) => dbg(`play() rejected: ${e.message}`))
      }
    },

    pause(): void {
      getAudio().pause()
    },

    play(): void {
      const s = get()
      if (s.current) {
        if (s.status === 'paused') resumedAt = Date.now()
        getAudio().play().catch((e: Error) => dbg(`play() rejected: ${e.message}`))
      }
    },

    next(auto = false): void {
      const s = get()
      if (s.queue.length === 0) return
      if (s.repeat === 'one' && auto && s.current) {
        pendingSeekPos = 0
        lastSeekAt = 0
        load(s.current)
        getAudio().play().catch((e: Error) => dbg(`play() rejected: ${e.message}`))
        return
      }
      let nextIdx = s.index + 1
      if (s.shuffle && s.queue.length > 1) {
        nextIdx = s.index
        while (nextIdx === s.index) {
          nextIdx = Math.floor(Math.random() * s.queue.length)
        }
      } else if (nextIdx >= s.queue.length) {
        if (s.repeat === 'queue' || !auto) {
          nextIdx = 0
        } else {
          set({ status: 'ended' })
          sendPlaybackState(makeSnapshot(get()))
          return
        }
      }
      const track = s.queue[nextIdx]
      set({ index: nextIdx, current: track })
      pushHistory(nextIdx)
      pendingSeekPos = 0
      lastSeekAt = 0
      load(track)
      getAudio().play().catch((e: Error) => dbg(`play() rejected: ${e.message}`))
      sendPlaybackState(makeSnapshot(get()))
    },

    previous(): void {
      const s = get()
      if (s.queue.length === 0) return
      if (s.currentTime > 3) {
        getAudio().currentTime = 0
        pendingSeekPos = 0
        lastSeekAt = Date.now()
        set({ currentTime: 0 })
        syncMain()
        return
      }
      // The queue array order is not the listen order when shuffle picked
      // random indices; walk the play history instead of index - 1 so the
      // song actually heard before this one is the one that restarts. The
      // top of the history is the current track: drop it, revealing the
      // previously played index (which stays on top as the new one).
      const h = s.history
      if (h.length > 1) {
        set({ history: h.slice(0, -1) })
        const prevIdx = h[h.length - 2]
        const track = s.queue[prevIdx]
        set({ index: prevIdx, current: track })
        pendingSeekPos = 0
        lastSeekAt = 0
        load(track)
        getAudio().play().catch((e: Error) => dbg(`play() rejected: ${e.message}`))
        sendPlaybackState(makeSnapshot(get()))
        return
      }
      // No distinct previous song in this listen session: restart the
      // current one instead of guessing a queue neighbor (which, with
      // shuffle on, would be an unrelated song).
      getAudio().currentTime = 0
      pendingSeekPos = 0
      lastSeekAt = Date.now()
      set({ currentTime: 0 })
      syncMain()
    },

    seek(seconds): void {
      const el = getAudio()
      // Online streams often choke on seeking (signed URLs re-fetch badly);
      // remember the target so fallback streams resume there instead of
      // restarting from 0 (or appearing to "skip"). Also remembered when the
      // duration is not known yet so a transcode/fallback reload can restore
      // the position once metadata loads.
      const cur = get().current
      if (cur && seconds > 0) pendingSeekPos = seconds
      lastSeekAt = Date.now()
      el.currentTime = clamp(seconds, 0, el.duration || 0)
      set({ currentTime: el.currentTime })
      syncMain()
    },

    setVolume(volume): void {
      const v = clamp(volume, 0, 1)
      const el = getAudio()
      el.volume = v
      // Adjusting the volume while muted is a request to hear again (and the
      // mini player slider would otherwise snap back to 0 / stay silent).
      if (v > 0 && el.muted) {
        el.muted = false
        set({ muted: false })
      }
      set({ volume: v })
      persistVolume(v)
      syncMainNow()
    },

    toggleMute(): void {
      const s = get()
      const el = getAudio()
      el.muted = !s.muted
      set({ muted: !s.muted })
      syncMainNow()
    },

    toggleShuffle(): void {
      const next = !get().shuffle
      set({ shuffle: next })
      void setSettings({ shuffle: next })
      syncMain()
    },

    cycleRepeat(): void {
      const order: RepeatMode[] = ['off', 'queue', 'one']
      const next = order[(order.indexOf(get().repeat) + 1) % order.length]
      set({ repeat: next })
      void setSettings({ repeat: next })
      syncMain()
    },

    removeFromQueue(id): void {
      const s = get()
      const idx = s.queue.findIndex((t) => t.id === id)
      if (idx === -1) return
      const queue = s.queue.filter((t) => t.id !== id)
      const removingCurrent = s.current?.id === id
      const index = removingCurrent ? -1 : s.index > idx ? s.index - 1 : s.index
      if (removingCurrent) {
        getAudio().pause()
        getAudio().removeAttribute('src')
      }
      const current = queue[index] ?? null
      set((st) => {
        // Keep history consistent with the trimmed queue: indices after the
        // removed slot shift down, and entries that no longer exist drop.
        // When the current track itself is removed there is nothing to anchor.
        if (removingCurrent) return { queue, index, current, history: [] }
        const h = st.history
          .filter((i) => i !== idx)
          .map((i) => (i > idx ? i - 1 : i))
          .filter((i) => i >= 0 && i < queue.length)
        const top = h[h.length - 1]
        const history = index >= 0 && top !== index ? [...h, index] : h
        return { queue, index, current, history }
      })
      persistQueue(queue)
      sendPlaybackState(makeSnapshot(get()))
    },

    clearQueue(): void {
      if (get().queue.length === 0) return
      getAudio().pause()
      getAudio().removeAttribute('src')
      set({ queue: [], index: -1, current: null, status: 'idle', currentTime: 0, duration: 0, history: [] })
      void clearQueueIPC()
      sendPlaybackState(makeSnapshot(get()))
    },

    patchTrack(id, patch): void {
      set((s) => ({
        queue: s.queue.map((t) => (t.id === id ? { ...t, ...patch } : t)),
        current: s.current?.id === id ? { ...s.current, ...patch } : s.current
      }))
    },

    stop(): void {
      const el = getAudio()
      el.pause()
      el.removeAttribute('src')
      clearStall()
      streamFallbacks = []
      streamFallbackIdx = 0
      set({ status: 'idle', current: null, currentTime: 0, duration: 0, index: -1, queue: [], history: [] })
      void clearQueueIPC()
      sendPlaybackState(makeSnapshot(get()))
    }
  }
})

/** Resume a previously playing song when the app restarts (settings-gated). */
export async function resumePlayback(): Promise<void> {
  try {
    const settings = await getSettings()
    if (!settings.resumeOnLaunch || !settings.lastSongId) return
    const track = await getSongById(settings.lastSongId)
    if (!track) return
    const s = usePlayer.getState()
    if (s.current) return
    // Play inside the restored queue when the song is still there; otherwise
    // append it so the queue survives and playback continues into it.
    const idx = s.queue.findIndex((t) => t.id === track.id)
    if (idx >= 0) {
      s.playTrack(track)
    } else {
      s.playTracks([...s.queue, track], s.queue.length, { source: 'library', sourceId: null })
    }
    if (settings.lastPositionSeconds > 0) {
      setTimeout(() => s.seek(settings.lastPositionSeconds), 300)
    }
  } catch {
    // ignore
  }
}