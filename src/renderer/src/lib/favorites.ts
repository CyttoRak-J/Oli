import type { QueryClient } from '@tanstack/react-query'

/** Refresh favorite state across lists, the favorites page and stats. */
export function invalidateFavorites(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['favorite-songs'] })
  void queryClient.invalidateQueries({ queryKey: ['songs'] })
  void queryClient.invalidateQueries({ queryKey: ['stats'] })
}
