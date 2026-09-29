/** Small POSIX-style stand-in for node:path (the phone app only ever sees "/" paths and content/file URIs). */
export const sep = '/'

function normalizeParts(parts: string[], absolute: boolean): string[] {
  const out: string[] = []
  for (const p of parts) {
    if (!p || p === '.') continue
    if (p === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
    } else out.push(p)
  }
  return out
}

export function normalize(p: string): string {
  const absolute = p.startsWith('/')
  const joined = normalizeParts(p.split('/'), absolute).join('/')
  return (absolute ? '/' : '') + joined || (absolute ? '/' : '.')
}

export function join(...parts: string[]): string {
  return normalize(parts.filter(Boolean).join('/'))
}

export function isAbsolute(p: string): boolean {
  return p.startsWith('/')
}

/** Like node's resolve, but with "/" as the working directory; URIs (file://, content://) are returned unchanged. */
export function resolve(...parts: string[]): string {
  let current = ''
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]
    if (!p) continue
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return p
    current = current ? `${p}/${current}` : p
    if (p.startsWith('/')) break
  }
  return normalize(current.startsWith('/') ? current : `/${current}`)
}

export function basename(p: string, ext?: string): string {
  const base = p.replace(/\/+$/, '').split('/').pop() ?? ''
  return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base
}

export function dirname(p: string): string {
  const trimmed = p.replace(/\/+$/, '')
  const i = trimmed.lastIndexOf('/')
  if (i < 0) return '.'
  return i === 0 ? '/' : trimmed.slice(0, i)
}

export function extname(p: string): string {
  const base = basename(p)
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i) : ''
}

export function relative(from: string, to: string): string {
  const a = resolve(from).split('/').filter(Boolean)
  const b = resolve(to).split('/').filter(Boolean)
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/')
}

export default { sep, normalize, join, isAbsolute, resolve, basename, dirname, extname, relative }
