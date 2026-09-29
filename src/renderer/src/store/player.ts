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
  resolveDownloadYouTubeAudio,
  getSimilarTracks,
  prefetchYouTubeStreams
} from '../lib/ipc'
import { clamp } from '../lib/format'
import { initMedia, localMediaUrl } from '../lib/media'
import { getNativeAudio, type AudioLike } from '../platform/nativeAudio'

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended'
export type RepeatMode = 'off' | 'queue' | 'one'

let audio: AudioLike | null = null

/** Renderer-side debug log (forwarded to the app log via console-message). */
const dbg = (...args: unknown[]): void => {
  try {
    console.log('[player]', ...args)
  } catch {
    // ignore
  }
}

const srcHost = (el: AudioLike): string => {
  try {
    const u = new URL(el.src)
    return u.hostname.slice(0, 28) || '(none)'
  } catch {
    return '(none)'
  }
}

function getAudio(): AudioLike {
  if (!audio) {
    // Android: the native Media3 player behind an object that looks like an audio element (background play, hi-res).
    audio = (typeof __OLI_WEB__ !== 'undefined' && __OLI_WEB__ ? getNativeAudio() : null) ?? new Audio()
    audio.preload = 'auto'
  }
  return audio
}

/** Ordered fallback stream URLs for the currently loaded track. */
let streamFallbacks: string[] = []
let streamFallbackIdx = 0

/** Track id we already tried to transcode (prevents infinite retry loops). */
let transcodedTrackId: string | null = null

/** Online tracks whose streams were already retried once after a refusal. */
const streamRetried = new Set<string>()

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

/**
 * True once the current source actually produced audio ('playing' fired).
 * A source that played fine and then errors (connection dropped during a
 * long pause, a USB/network drive that spun down) is retried in place at the
 * same position before any transcode / fallback / skip is attempted.
 */
let playedOk = false
/** In-place reload attempts for the current source (bounded to avoid loops). */
let srcRetries = 0
const MAX_SRC_RETRIES = 2

/** Playback position when the last 'waiting' began (stall progress check). */
let waitingAtPos = 0

/** Local file whose eager transcode must be swapped in once ready because the original failed. */
let awaitingTranscodeId: string | null = null

/** Consecutive tracks that failed to play; stops a queue of dead tracks from cycling forever. */
let failureStreak = 0

/** Track ids already played in the current shuffle cycle (no repeats until all have played). */
const shufflePlayed = new Set<string>()

/** Playback settings from Preferences (applied to every loaded source). */
const audioPrefs = {
  speed: 1,
  preservePitch: true,
  replayGain: 'off' as 'off' | 'track' | 'album'
}

/**
 * Element volume for the user's volume and the track's ReplayGain. Only
 * attenuation is possible with the media element (volume is capped at 1),
 * which covers the usual case of loud masters.
 */
function effectiveVolume(volume: number, track: Track | null): number {
  let db: number | null = null
  if (track && audioPrefs.replayGain === 'track') db = track.replayGain ?? track.replayGainAlbum
  else if (track && audioPrefs.replayGain === 'album') db = track.replayGainAlbum ?? track.replayGain
  const factor = db != null && Number.isFinite(db) ? Math.min(1, Math.pow(10, db / 20)) : 1
  return clamp(volume * factor, 0, 1)
}

function applyRate(el: AudioLike): void {
  // defaultPlaybackRate survives new sources; playbackRate resets on load.
  el.defaultPlaybackRate = audioPrefs.speed
  el.playbackRate = audioPrefs.speed
  el.preservesPitch = audioPrefs.preservePitch
}

/**
 * Remember the current position so a reload of the SAME track (transcode,
 * fallback stream, download) continues where it was instead of restarting.
 */
function rememberPosition(el: AudioLike): void {
  const t = el.currentTime
  if (pendingSeekPos === 0 && Number.isFinite(t) && t > 0.5) pendingSeekPos = t
}

/** Point the element at a new source (resets per-source retry bookkeeping). */
function switchSrc(el: AudioLike, url: string): void {
  playedOk = false
  srcRetries = 0
  el.src = url
  applyRate(el)
}

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
  /** ADDED: when true, an empty-queue "ended" state auto-extends the queue
   *  with similar tracks (same artist, then same genre) instead of stopping. */
  radioMode: boolean
  toggleRadioMode: () => void

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

/** Drop repeated track ids, keeping the first occurrence (queue is keyed by id). */
function dedupeTracks(tracks: Track[]): Track[] {
  const seen = new Set<string>()
  return tracks.filter((t) => {
    if (seen.has(t.id)) return false
    seen.add(t.id)
    return true
  })
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
    awaitingTranscodeId = null
    streamFallbacks = []
    streamFallbackIdx = 0
    shufflePlayed.add(track.id)
    streamRetried.delete(track.id)
    set({ current: track, status: 'loading', currentTime: 0, duration: 0 })
    // Resolve the next YouTube songs in the queue while this one plays, so
    // the transition needs no wait.
    {
      const st = get()
      const upcoming: string[] = []
      for (let k = 1; k <= 2; k++) {
        const nt = st.queue[st.index + k]
        if (nt && !nt.path && nt.id.startsWith('youtube:')) upcoming.push(nt.id.slice('youtube:'.length))
      }
      if (upcoming.length > 0) prefetchYouTubeStreams(upcoming, true)
    }
    el.volume = effectiveVolume(get().volume, track)
    // Native player: labels for the notification / lock screen.
    el.setMetadata?.({
      title: track.title,
      artist: track.artist,
      album: track.album,
      artworkUri: track.artworkUrl && /^https?:/.test(track.artworkUrl) ? track.artworkUrl : '',
      bitDepth: track.bitDepth ?? undefined
    })
    // Online tracks resolve their stream at play time (see freshResolveOnline).
    if (track.id.startsWith('youtube:') && !track.path) {
      freshResolveOnline(track)
      return
    }
    // Local file (or an online track already downloaded earlier in session).
    switchSrc(el, localMediaUrl(track.path))
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
        // The original failed while this transcode was running (the error
        // handler parked the track here): swap in the MP3, or give up.
        const originalFailed = awaitingTranscodeId === track.id || el.error != null
        awaitingTranscodeId = null
        if (mp3 && (s.status === 'loading' || originalFailed || !playedOk)) {
          clearStall()
          transcodedTrackId = track.id
          rememberPosition(el)
          switchSrc(el, localMediaUrl(mp3))
          el.play().catch((e: Error) => dbg(`play() rejected: ${e.message}`))
        } else if (!mp3 && originalFailed) {
          skipCurrent()
        }
        // Otherwise the original file is already playing fine.
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
      // streamFallbacks holds the FULL list; streamFallbackIdx is the URL
      // currently playing, so the error handler tries idx + 1 next.
      streamFallbacks = [...track.streamUrls]
      streamFallbackIdx = 0
      const el = getAudio()
      switchSrc(el, track.streamUrls[0])
      dbg(`play-pre-resolved url#0 of ${track.streamUrls.length}`)
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
          urls = await resolveYouTubeStream(videoId, attempt > 0).catch(() => [] as string[])
        }
        if (!stillCurrent()) return
        if (urls.length > 0) {
          streamFallbacks = [...urls]
          streamFallbackIdx = 0
          const el = getAudio()
          switchSrc(el, urls[0])
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
    rememberPosition(getAudio())
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
        const urls = await resolveYouTubeStream(videoId, true).catch(() => [] as string[])
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
    if (transcodeInFlight === cur.id) {
      // A transcode (e.g. the eager one started by load()) is still running:
      // park the track so its completion swaps the MP3 in (or skips).
      awaitingTranscodeId = cur.id
      set({ status: 'loading' })
      return true
    }
    if (transcodedTrackId === cur.id) return false
    transcodedTrackId = cur.id
    transcodeInFlight = cur.id
    clearStall()
    rememberPosition(getAudio())
    set({ status: 'loading' })
    void transcodeLocalFile(cur.path).then((mp3) => {
      if (transcodeInFlight === cur.id) transcodeInFlight = null
      const el = getAudio()
      // The user may have moved on while transcoding; never hijack playback.
      if (get().current?.id !== cur.id) return
      if (mp3) {
        switchSrc(el, localMediaUrl(mp3))
        el.play().catch((e: Error) => dbg(`play() rejected: ${e.message}`))
      } else {
        skipCurrent()
      }
    })
    return true
  }

  /**
   * Skip a track that cannot be played. Always moves on (even with
   * repeat-one, which would otherwise reload the same dead track forever),
   * and stops once every track in the queue has failed in a row.
   */
  const skipCurrent = (): void => {
    clearStall()
    const s = get()
    failureStreak += 1
    if (s.queue.length > 0 && failureStreak < s.queue.length) {
      set({ status: 'ended' })
      advance(true, true)
    } else {
      failureStreak = 0
      const el = getAudio()
      el.pause()
      set({ status: 'idle' })
      syncMainNow()
    }
  }

  /** Reopen the current source at the current position (see playedOk). */
  const reloadInPlace = (): void => {
    const el = getAudio()
    const src = el.currentSrc || el.src
    if (!src) return
    srcRetries += 1
    rememberPosition(el)
    dbg(`reload-in-place #${srcRetries} at ${pendingSeekPos.toFixed(1)}s`)
    clearStall()
    set({ status: 'loading' })
    // playedOk goes false so a reload that errors right away falls through
    // to the normal fallback chain instead of retrying again.
    playedOk = false
    el.src = src
    el.play().catch((e: Error) => dbg(`play() rejected (reload): ${e.message}`))
    stallTimer = setTimeout(stallWatchdog, 15000)
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
    // Playback moved on (or has enough data) since the 'waiting' started:
    // it recovered by itself and only the 'playing' event was missed.
    if (elNow.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA || elNow.currentTime > waitingAtPos + 0.5) {
      set({ status: 'playing' })
      syncMainNow()
      return
    }
    // Never throw away the listened part when falling back below.
    rememberPosition(elNow)
    const sinceSeek = Date.now() - lastSeekAt
    const sinceResume = Date.now() - resumedAt
    const userDriven = sinceSeek < 60000 || sinceResume < 60000
    // A source that already played fine usually just lost its connection
    // (long pause, sleeping drive): reopening it in place is the cheapest
    // fix and keeps the position, before anything heavier is tried.
    if (playedOk && srcRetries < MAX_SRC_RETRIES) {
      reloadInPlace()
      return
    }
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
          void resolveYouTubeStream(videoId, true)
            .then((urls) => {
              if (freshResolvingId === cur.id) freshResolvingId = null
              if (urls.length === 0) return
              if (get().current?.id !== cur.id) return
              const el = getAudio()
              streamFallbacks = [...urls]
              streamFallbackIdx = 0
              switchSrc(el, urls[0])
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

  /** Start playing queue slot `idx` as the next track. */
  const startAt = (idx: number): void => {
    const track = get().queue[idx]
    if (!track) return
    set({ index: idx, current: track })
    pushHistory(idx)
    pendingSeekPos = 0
    lastSeekAt = 0
    load(track)
    getAudio().play().catch((e: Error) => dbg(`play() rejected: ${e.message}`))
    sendPlaybackState(makeSnapshot(get()))
  }

  /** Nothing left to play: stop at the end of the queue. */
  const endQueue = (): void => {
    set({ status: 'ended' })
    sendPlaybackState(makeSnapshot(get()))
  }

  /**
   * Radio mode: extend the queue with similar tracks instead of stopping.
   * Fire-and-forget, since next() is called synchronously from media keys,
   * tray, thumbar and IPC commands.
   */
  const extendWithRadio = (seed: Track): void => {
    set({ status: 'loading' })
    const excludeIds = get().queue.map((t) => t.id)
    void getSimilarTracks(seed.id, excludeIds, 10)
      .then((similar) => {
        // The user started something else while this was loading.
        if (get().current?.id !== seed.id) return
        const fresh = similar.filter((t) => !get().queue.some((q) => q.id === t.id))
        if (fresh.length === 0) {
          // Nothing similar found (e.g. missing genre/artist tags): stop
          // instead of being stuck "loading" forever.
          endQueue()
          return
        }
        const start = get().queue.length
        const queue = [...get().queue, ...fresh]
        set({ queue })
        persistQueue(queue)
        startAt(start)
      })
      .catch((err) => {
        dbg(`radio mode fetch failed: ${(err as Error).message}`)
        if (get().current?.id === seed.id) endQueue()
      })
  }

  /**
   * Move to the next track. `auto` is true when the current track ended (or
   * failed) on its own, false for an explicit Next press. `ignoreRepeatOne`
   * is used when skipping an unplayable track so repeat-one cannot reload
   * the same dead track forever.
   */
  const advance = (auto: boolean, ignoreRepeatOne: boolean): void => {
    const s = get()
    if (s.queue.length === 0) return
    if (s.repeat === 'one' && auto && !ignoreRepeatOne && s.current) {
      // Replay in place: no reload / stream re-resolve needed.
      const el = getAudio()
      pendingSeekPos = 0
      lastSeekAt = 0
      try {
        el.currentTime = 0
      } catch {
        // ignore
      }
      set({ currentTime: 0 })
      el.play().catch((e: Error) => dbg(`play() rejected: ${e.message}`))
      return
    }
    if (s.shuffle && s.queue.length > 1) {
      // Shuffle without repeats: pick among the tracks not yet played in
      // this cycle; a new cycle starts once every track has played.
      let pool = s.queue
        .map((t, i) => ({ t, i }))
        .filter(({ t, i }) => i !== s.index && !shufflePlayed.has(t.id))
      if (pool.length === 0) {
        if (auto && s.repeat === 'off') {
          if (s.radioMode && s.current) extendWithRadio(s.current)
          else endQueue()
          return
        }
        shufflePlayed.clear()
        if (s.current) shufflePlayed.add(s.current.id)
        pool = s.queue.map((t, i) => ({ t, i })).filter(({ i }) => i !== s.index)
      }
      startAt(pool[Math.floor(Math.random() * pool.length)].i)
      return
    }
    let nextIdx = s.index + 1
    if (nextIdx >= s.queue.length) {
      if (s.repeat === 'queue' || !auto) {
        nextIdx = 0
      } else if (s.radioMode && s.current) {
        extendWithRadio(s.current)
        return
      } else {
        endQueue()
        return
      }
    }
    startAt(nextIdx)
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
    radioMode: false,

    async hydrate(): Promise<void> {
      const el = getAudio()
      await initMedia()
      const queue = await getQueue().catch(() => [])
      // Nothing is loaded yet, so no queue slot is "current": index -1 makes
      // play/next start at the first restored track (index 0 made next()
      // jump straight to the second one). Skipped when a track is already
      // playing (a second hydrate from a StrictMode remount).
      if (queue.length > 0 && !get().current) {
        const tracks = queue.map((e) => e.track).filter((t): t is Track => Boolean(t))
        set({ queue: dedupeTracks(tracks), index: -1, history: [] })
      }

      // Restore volume, shuffle and repeat from saved settings.
      const settings = await getSettings().catch(() => null)
      if (settings) {
        applyAudioSettings(settings)
        const volume = clamp(Number(settings.volume ?? 0.8), 0, 1)
        el.volume = effectiveVolume(volume, get().current)
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

      // Notification / lock screen / headset asked for another song (the queue lives here, not in the native player).
      el.addEventListener('nativecommand', (e) => {
        const cmd = (e as CustomEvent<string>).detail
        if (cmd === 'next') get().next()
        else if (cmd === 'previous') get().previous()
      })
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
        const curId = get().current?.id
        if (real > 0 && curId) get().patchTrack(curId, { duration: real })
        // Restore the position the user clicked / paused at: reloads and
        // fallback streams continue from there instead of restarting at 0.
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
        if (!get().current) return
        set({ status: 'playing' })
        syncMainNow()
      })
      el.addEventListener('pause', () => {
        clearStall()
        // stop() / clearQueue() / a dead queue already moved to 'idle'; the
        // (asynchronous) pause event must not turn that back into 'paused'.
        if (get().status === 'idle') return
        // Remember where the user stopped: if playback must be reloaded after
        // resume (connection dropped, transcode / download fallback), it
        // continues from here instead of restarting from 0.
        const cur = get().current
        const t = el.currentTime
        if (cur && t > 0 && (!el.duration || t < el.duration) && pendingSeekPos === 0) {
          pendingSeekPos = t
        }
        set({ status: 'paused', currentTime: t || get().currentTime })
        syncMainNow()
      })
      el.addEventListener('waiting', () => {
        if (!get().current?.path) dbg(`waiting (${srcHost(el)})`)
        if (!get().current) return
        set({ status: 'loading' })
        clearStall()
        waitingAtPos = el.currentTime
        // A seek or a resume-from-pause starts a fresh re-buffer; the
        // watchdog gives those a long grace window (it would otherwise
        // restart or skip the song on slow media).
        const userDriven = Date.now() - lastSeekAt < 10000 || Date.now() - resumedAt < 10000
        stallTimer = setTimeout(stallWatchdog, userDriven ? 20000 : 10000)
        syncMainNow()
      })
      el.addEventListener('playing', () => {
        if (!get().current?.path) dbg(`playing-event fired (${srcHost(el)})`)
        clearStall()
        playedOk = true
        failureStreak = 0
        pendingSeekPos = 0
        lastSeekAt = 0
        set({ status: 'playing' })
        syncMainNow()
      })
      el.addEventListener('seeked', () => {
        // The seek landed: the element's own position is authoritative now.
        // A stale target would otherwise be restored by a later reload and
        // jump the song back to where the user once clicked.
        if (!el.paused) pendingSeekPos = 0
      })
      el.addEventListener('ended', () => {
        if (!get().current) return
        get().next(true)
      })
      el.addEventListener('error', () => {
        clearStall()
        const failed = get().current
        // Removing the src attribute (queue edits, stop) fires a spurious
        // MEDIA_ERR_SRC_NOT_SUPPORTED error event with no current track; with
        // a null current the fallback chain must not start or skip anything.
        if (!failed) return
        // Chromium's message names the real cause (e.g. DEMUXER_ERROR_*,
        // PIPELINE_ERROR_DECODE, or a failed protocol request).
        const srcName = (() => {
          try {
            return decodeURIComponent(el.src).split(/[\\/]/).pop()?.slice(0, 80) ?? ''
          } catch {
            return ''
          }
        })()
        dbg(
          `audio-error code=${el.error?.code} msg="${el.error?.message ?? ''}" played=${playedOk} ` +
            `idx=${streamFallbackIdx} fbs=${streamFallbacks.length} src=${failed.path ? srcName : srcHost(el)}`
        )
        // The source was playing fine and then failed (network connection
        // dropped during a pause, a drive went to sleep): reopen it at the
        // same position before treating the track as broken.
        if (playedOk && srcRetries < MAX_SRC_RETRIES) {
          reloadInPlace()
          return
        }
        if (streamFallbackIdx + 1 < streamFallbacks.length) {
          streamFallbackIdx += 1
          const next = streamFallbacks[streamFallbackIdx]
          rememberPosition(el)
          set({ status: 'loading' })
          // A short delay lets Chromium finish aborting the failed source;
          // switching instantly can surface spurious format errors.
          setTimeout(() => {
            if (get().current?.id !== failed.id) return
            playedOk = false
            srcRetries = 0
            el.src = next
            el.play().catch((e: Error) => dbg(`play() rejected: ${e.message}`))
          }, 300)
          return
        }
        // YouTube briefly refuses brand-new stream URLs; a short wait and one
        // more pass over the same URLs beats the slow download fallback.
        if (!failed.path && streamFallbacks.length > 0 && !streamRetried.has(failed.id)) {
          streamRetried.add(failed.id)
          set({ status: 'loading' })
          setTimeout(() => {
            if (get().current?.id !== failed.id || streamFallbacks.length === 0) return
            streamFallbackIdx = 0
            playedOk = false
            srcRetries = 0
            el.src = streamFallbacks[0]
            el.play().catch((e: Error) => dbg(`play() rejected: ${e.message}`))
          }, 1500)
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
            rememberPosition(el)
            set({ status: 'loading' })
            void resolveYouTubeStream(videoId, true)
              .then((urls) => {
                if (freshResolvingId === failed.id) freshResolvingId = null
                // The user may have moved on meanwhile: never skip or
                // hijack a different track.
                if (get().current?.id !== failed.id) return
                if (urls.length === 0) {
                  skipCurrent()
                  return
                }
                const elNow = getAudio()
                streamFallbacks = [...urls]
                streamFallbackIdx = 0
                switchSrc(elNow, urls[0])
                elNow.play().catch((e: Error) => dbg(`play() rejected: ${e.message}`))
              })
              .catch(() => {
                if (freshResolvingId === failed.id) freshResolvingId = null
                if (get().current?.id === failed.id) skipCurrent()
              })
            return
          }
        }
        skipCurrent()
      })
    },

    playTracks(tracks, startIndex, source): void {
      if (tracks.length === 0) return
      // The queue is keyed by track id everywhere (playTrack, removeFromQueue,
      // list keys, persisted queue rows): collapse duplicates, keeping the
      // clicked track as the start.
      const clicked = tracks[clamp(startIndex, 0, tracks.length - 1)]
      const queue = dedupeTracks(tracks)
      const idx = Math.max(0, queue.findIndex((t) => t.id === clicked.id))
      const track = queue[idx]
      pendingSeekPos = 0
      lastSeekAt = 0
      failureStreak = 0
      shufflePlayed.clear()
      set({ queue, index: idx, current: track, source })
      resetHistory(idx)
      load(track)
      getAudio().play().catch((e: Error) => dbg(`play() rejected: ${e.message}`))
      persistQueue(queue)
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
        failureStreak = 0
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
      // Indices at/after the insertion point shift up by one; keep the play
      // history pointing at the same tracks (previous() walks it).
      const history = s.history.map((i) => (i >= at ? i + 1 : i))
      // Let it play next even when shuffle already played it this cycle.
      shufflePlayed.delete(track.id)
      set({ queue, history })
      persistQueue(queue)
      sendPlaybackState(makeSnapshot(get()))
    },

    toggle(): void {
      const s = get()
      const el = getAudio()
      if (!s.current) {
        // Nothing loaded yet (fresh launch with a restored queue): start it.
        if (s.queue.length > 0) get().next()
        return
      }
      // Decide on the element itself, not the status: while buffering the
      // status is 'loading' but the audio is running, and a press must pause.
      if (!el.paused && (s.status === 'playing' || s.status === 'loading')) {
        el.pause()
        return
      }
      get().play()
    },

    pause(): void {
      getAudio().pause()
    },

    play(): void {
      const s = get()
      if (!s.current) {
        if (s.queue.length > 0) get().next()
        return
      }
      const el = getAudio()
      if (!el.paused) return
      if (s.status === 'paused' || s.status === 'loading') resumedAt = Date.now()
      if (s.status === 'ended' || s.status === 'idle') {
        // Finished / stopped track: play it again from the start.
        pendingSeekPos = 0
        load(s.current)
      }
      el.play().catch((e: Error) => dbg(`play() rejected: ${e.message}`))
    },

    next(auto = false): void {
      advance(auto, false)
    },

    previous(): void {
      const s = get()
      if (s.queue.length === 0) return
      if (s.currentTime > 3 && s.current && s.status !== 'ended') {
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
        if (!track) {
          set({ history: [] })
          return
        }
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
      if (!s.current) {
        get().next()
        return
      }
      const el = getAudio()
      el.currentTime = 0
      pendingSeekPos = 0
      lastSeekAt = Date.now()
      set({ currentTime: 0 })
      if (s.status === 'ended') get().play()
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
      if (!cur || !Number.isFinite(seconds)) return
      const target = Math.max(0, seconds)
      pendingSeekPos = target > 0 ? target : 0
      lastSeekAt = Date.now()
      // Before metadata the element reports NaN duration; clamping to 0 then
      // would silently rewind to the start. Use the known track duration,
      // and let loadedmetadata apply pendingSeekPos if it is still unknown.
      const max = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : get().duration
      const pos = max > 0 ? Math.min(target, max) : target
      try {
        if (el.readyState > 0) el.currentTime = pos
      } catch {
        // ignore: applied on loadedmetadata via pendingSeekPos
      }
      set({ currentTime: pos })
      syncMainNow()
    },

    setVolume(volume): void {
      const v = clamp(volume, 0, 1)
      const el = getAudio()
      el.volume = effectiveVolume(v, get().current)
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
      // Mini player shows the state from main: don't let the throttle hide the change.
      syncMainNow()
    },

    toggleRadioMode(): void {
      set({ radioMode: !get().radioMode })
    },

    cycleRepeat(): void {
      const order: RepeatMode[] = ['off', 'queue', 'one']
      const next = order[(order.indexOf(get().repeat) + 1) % order.length]
      set({ repeat: next })
      void setSettings({ repeat: next })
      syncMainNow()
    },

    removeFromQueue(id): void {
      const s = get()
      const idx = s.queue.findIndex((t) => t.id === id)
      if (idx === -1) return
      const queue = s.queue.filter((t) => t.id !== id)
      const removingCurrent = s.current?.id === id
      const index = removingCurrent ? -1 : s.index > idx ? s.index - 1 : s.index
      if (removingCurrent) {
        clearStall()
        streamFallbacks = []
        streamFallbackIdx = 0
        pendingSeekPos = 0
        set({ status: 'idle', currentTime: 0, duration: 0 })
        getAudio().pause()
        getAudio().removeAttribute('src')
      }
      shufflePlayed.delete(id)
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
      clearStall()
      streamFallbacks = []
      streamFallbackIdx = 0
      pendingSeekPos = 0
      shufflePlayed.clear()
      set({ queue: [], index: -1, current: null, status: 'idle', currentTime: 0, duration: 0, history: [] })
      getAudio().pause()
      getAudio().removeAttribute('src')
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
      clearStall()
      streamFallbacks = []
      streamFallbackIdx = 0
      pendingSeekPos = 0
      shufflePlayed.clear()
      set({ status: 'idle', current: null, currentTime: 0, duration: 0, index: -1, queue: [], history: [] })
      el.pause()
      el.removeAttribute('src')
      void clearQueueIPC()
      sendPlaybackState(makeSnapshot(get()))
    }
  }
})

/** Apply the Preferences audio settings (speed, pitch, ReplayGain) live. */
export function applyAudioSettings(s: {
  playbackSpeed?: number
  preservePitch?: boolean
  replayGainMode?: string
  bitPerfectOutput?: boolean
}): void {
  const speed = Number(s.playbackSpeed)
  audioPrefs.speed = Number.isFinite(speed) && speed >= 0.25 && speed <= 4 ? speed : 1
  audioPrefs.preservePitch = s.preservePitch !== false
  audioPrefs.replayGain =
    s.replayGainMode === 'track' || s.replayGainMode === 'album' ? s.replayGainMode : 'off'
  const el = getAudio()
  applyRate(el)
  void el.setBitPerfect?.(s.bitPerfectOutput === true)?.catch(() => undefined)
  const st = usePlayer.getState()
  el.volume = effectiveVolume(st.volume, st.current)
}

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
