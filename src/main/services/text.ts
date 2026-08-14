/** Text normalization and fuzzy helpers shared across search and statistics. */

export function normalizeText(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Collation-friendly sort key (e.g. moves "The", "A", "An" to the end-ignored prefix). */
export function sortKey(input: string): string {
  const s = normalizeText(input).replace(/^(a|an|the)\s+/, '').replace(/[^a-z0-9]/g, '')
  return s || 'zzzz'
}

export function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = new Array<number>(n + 1)
  let curr = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    const tmp = prev
    prev = curr
    curr = tmp
  }
  return prev[n]
}

/**
 * Similarity score in [0, 1] tolerant to typos (Damerau-style by combining
 * normalization with Levenshtein on the query-bounded window).
 */
export function fuzzyScore(query: string, target: string): number {
  const q = normalizeText(query)
  const t = normalizeText(target)
  if (!q || !t) return 0
  if (t === q) return 1
  if (t.includes(q)) {
    return Math.max(0.6, 1 - (t.length - q.length) / (Math.max(t.length, 1) * 2))
  }
  const windowLen = Math.min(t.length, q.length + 4)
  const dist = levenshtein(q, t.slice(0, windowLen))
  return Math.max(0, 1 - dist / Math.max(q.length, windowLen))
}

/** Parses "3:45", "1:02:03" into seconds (used by playlist importers). */
export function parseDurationString(input: string): number | null {
  const m = input.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.\d+)?/)
  if (!m) return null
  const h = m[1] ? Number(m[1]) : 0
  const min = Number(m[2])
  const sec = Number(m[3])
  if (sec >= 60 || min >= 60) return null
  return h * 3600 + min * 60 + sec
}

/** "3:45" / "1:02:03" formatting from seconds. */
export function formatSeconds(total: number): string {
  const s = Math.max(0, Math.floor(total))
  const hours = Math.floor(s / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  const secs = s % 60
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = ''
  for (const u of units) {
    value /= 1024
    unit = u
    if (value < 1024) break
  }
  return `${value.toFixed(1)} ${unit}`
}