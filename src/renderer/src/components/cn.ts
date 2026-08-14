/** Classname helper guarding against falsy entries (tiny clsx substitute). */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}