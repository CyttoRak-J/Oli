import { useEffect } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { on, search as runSearch, prefetchYouTubeStreams } from './ipc'
import { IPC } from '@shared/ipc'
import type { OnlineSearchResult, SearchResults } from '@shared/types'

/**
 * Subscribes to `search:online` events pushed by the main process and merges
 * the late-arriving provider results into the shared `['search', q]` query
 * cache, so local results render instantly and online results appear when
 * they are ready (no re-fetch, no flash).
 */
/**
 * Query function for ['search', q]. The online results event can arrive
 * BEFORE the local results (always the case when no provider is configured);
 * the local response then overwrote it, so "Searching online providers…"
 * spun forever and "No results" never appeared. Keep what already arrived.
 */
export async function searchKeepingOnline(
  queryClient: QueryClient,
  q: string,
  record = false
): Promise<SearchResults> {
  const res = await runSearch(q, undefined, record)
  const prev = queryClient.getQueryData<SearchResults>(['search', q])
  if (prev?.onlineDone) return { ...res, online: prev.online, onlineDone: true }
  return res
}

/**
 * Resolve the streams of the first online results in the background: by the
 * time one is clicked, Play is instant instead of waiting ~4 s for yt-dlp.
 */
export function usePrefetchOnlineStreams(online: OnlineSearchResult[]): void {
  const ids = online
    .map((r) => r.videoId)
    .filter((id): id is string => Boolean(id))
    .slice(0, 4)
    .join(',')
  useEffect(() => {
    if (ids) prefetchYouTubeStreams(ids.split(','))
  }, [ids])
}

export function useLiveOnlineSearch(debounced: string): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    return on<{ query: string; online: OnlineSearchResult[]; done?: boolean }>(
      IPC.onSearchOnline,
      (payload) => {
        if (payload.query !== debounced) return
        queryClient.setQueryData<SearchResults>(['search', payload.query], (prev) => ({
          local: prev?.local ?? [],
          suggestions: prev?.suggestions ?? [],
          online: payload.online,
          onlineDone: payload.done === true
        }))
      }
    )
  }, [debounced, queryClient])
}
