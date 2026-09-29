import { describe, expect, it } from 'vitest'
import { shuffled } from '../src/renderer/src/lib/shuffle'

describe('shuffled', () => {
  const items = Array.from({ length: 50 }, (_, i) => i)

  it('returns every item exactly once and leaves the input alone', () => {
    const copy = [...items]
    const out = shuffled(items)
    expect(out).toHaveLength(items.length)
    expect([...out].sort((a, b) => a - b)).toEqual(items)
    expect(items).toEqual(copy)
  })

  it('actually reorders (a fixed rng gives a fixed, non-identity order)', () => {
    let seed = 7
    const rng = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const a = shuffled(items, rng)
    seed = 7
    expect(shuffled(items, rng)).toEqual(a)
    expect(a).not.toEqual(items)
  })

  it('handles empty and one-item lists', () => {
    expect(shuffled([])).toEqual([])
    expect(shuffled(['x'])).toEqual(['x'])
  })
})
