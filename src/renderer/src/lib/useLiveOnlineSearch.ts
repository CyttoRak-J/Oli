import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { on } from './ipc'
import { IPC } from '@shared/ipc'
import type { OnlineSearchResult, SearchResults } from '@shared/types'

/**
 * Subscribes to `search:online` events pushed by the main process and merges
 * the late-arriving provider results into the shared `['search', q]` query
 * cache, so local results render instantly and online results appear when
 * they are ready (no re-fetch, no flash).
 */
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