import { describe, expect, it } from 'vitest'
import { computeWindow } from '../src/renderer/src/lib/useRowWindow'

describe('long lists only keep the rows on screen', () => {
  const ROW = 46
  it('at the top: the first rows plus a margin below', () => {
    expect(computeWindow(0, 200, 700, ROW, 3000, 12)).toEqual({ first: 0, last: Math.ceil((0 - 200 + 700) / ROW) + 12 })
  })

  it('in the middle: the rows in view plus a margin above and below', () => {
    const w = computeWindow(46 * 1000 + 200, 200, 690, ROW, 3000, 12)
    expect(w.first).toBe(1000 - 12)
    expect(w.last).toBe(1000 + 15 + 12)
    expect(w.last - w.first).toBeLessThan(45)
  })

  it('at the end: never past the last row', () => {
    const w = computeWindow(46 * 3000 + 200 - 690, 200, 690, ROW, 3000, 12)
    expect(w.last).toBe(3000)
    expect(w.first).toBeGreaterThan(2900)
  })

  it('an empty or short list, and a list scrolled out of sight', () => {
    expect(computeWindow(0, 0, 700, ROW, 0, 12)).toEqual({ first: 0, last: 0 })
    expect(computeWindow(0, 0, 700, ROW, 5, 12)).toEqual({ first: 0, last: 5 })
    // the list is far below the screen (header taller than the view): nothing needed yet beyond the margin
    const below = computeWindow(0, 5000, 700, ROW, 3000, 12)
    expect(below.first).toBe(0)
    expect(below.last).toBeLessThanOrEqual(12)
    // scrolled far past the end
    expect(computeWindow(10_000_000, 0, 700, ROW, 3000, 12)).toEqual({ first: 3000, last: 3000 })
  })
})
