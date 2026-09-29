import { getLogger } from './logger'
import {
  ARCHIVE_API,
  ARCHIVE_ITEM_CACHE_MS,
  ARCHIVE_MAX_COVER_BYTES,
  ARCHIVE_TIMEOUT_MS,
  ARCHIVE_USER_AGENT,
  buildDownloadUrl,
  buildSearchUrl,
  isValidIdentifier,
  parseHits,
  parseItem,
  pickCover
} from '@shared/archiveCore'
import type { ArchiveItem, ArchiveSearchResult } from '@shared/types'

// The pure helpers live in shared/archiveCore.ts; re-exported so existing imports keep working.
export * from '@shared/archiveCore'

async function getJson(url: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ARCHIVE_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': ARCHIVE_USER_AGENT, Accept: 'application/json' },
      signal: controller.signal
    })
    if (!res.ok) throw new Error(`archive.org answered HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function describe(err: unknown): string {
  const e = err as Error
  if (e?.name === 'AbortError') return 'archive.org took too long to answer'
  return e?.message || 'Could not reach archive.org'
}

/**
 * Internet Archive (archive.org) search and file listing. Public, keyless
 * endpoints only; files download through the normal download queue.
 */
export class ArchiveService {
  private items = new Map<string, { at: number; item: ArchiveItem }>()
  private covers = new Map<string, Buffer>()

  async search(text: string, page = 1, losslessOnly = true): Promise<ArchiveSearchResult> {
    const url = buildSearchUrl(text, page, losslessOnly)
    if (!url) return { hits: [], total: 0, page: 1 }
    try {
      const { hits, total } = parseHits(await getJson(url))
      return { hits, total, page }
    } catch (err) {
      getLogger().warn('archive search failed', err)
      return { hits: [], total: 0, page, error: describe(err) }
    }
  }

  async getItem(identifier: string): Promise<ArchiveItem> {
    if (!isValidIdentifier(identifier)) {
      return { identifier: String(identifier), title: '', creator: null, date: null, licenseUrl: null, files: [], images: [], error: 'Invalid item' }
    }
    const cached = this.items.get(identifier)
    if (cached && Date.now() - cached.at < ARCHIVE_ITEM_CACHE_MS) return cached.item
    try {
      const body = await getJson(`${ARCHIVE_API}/metadata/${encodeURIComponent(identifier)}`)
      const item = parseItem(identifier, body)
      this.items.set(identifier, { at: Date.now(), item })
      if (this.items.size > 50) this.items.delete(this.items.keys().next().value as string)
      return item
    } catch (err) {
      getLogger().warn('archive item failed', err)
      return { identifier, title: identifier, creator: null, date: null, licenseUrl: null, files: [], images: [], error: describe(err) }
    }
  }

  /** Cover picture for a file of an item, or null (missing, too big, or the request failed). */
  async getCover(item: ArchiveItem, audioName: string): Promise<Buffer | null> {
    const pick = pickCover(item.images, audioName)
    if (!pick) return null
    const key = `${item.identifier}/${pick.name}`
    const hit = this.covers.get(key)
    if (hit) return hit
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ARCHIVE_TIMEOUT_MS)
    try {
      const res = await fetch(buildDownloadUrl(item.identifier, pick.name), {
        headers: { 'User-Agent': ARCHIVE_USER_AGENT },
        signal: controller.signal
      })
      if (!res.ok) return null
      const data = Buffer.from(await res.arrayBuffer())
      if (data.length === 0 || data.length > ARCHIVE_MAX_COVER_BYTES) return null
      this.covers.set(key, data)
      if (this.covers.size > 6) this.covers.delete(this.covers.keys().next().value as string)
      return data
    } catch (err) {
      getLogger().debug('archive cover failed', err)
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}
