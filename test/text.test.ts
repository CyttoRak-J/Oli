import { describe, it, expect } from 'vitest'
import {
  normalizeText,
  sortKey,
  levenshtein,
  fuzzyScore,
  parseDurationString,
  formatSeconds,
  formatFileSize
} from '../src/main/services/text'

describe('normalizeText', () => {
  it('strips accents, lowercases, collapses whitespace', () => {
    expect(normalizeText('  Café   Del  Mar  ')).toBe('cafe del mar')
  })
  it('strips apostrophes', () => {
    expect(normalizeText("Guns N' Roses")).toBe('guns n roses')
  })
})

describe('sortKey', () => {
  it('moves leading articles out of the sort position', () => {
    expect(sortKey('The Beatles') < sortKey('Aerosmith')).toBe(false)
  })
})

describe('levenshtein', () => {
  it('is 0 for identical strings', () => {
    expect(levenshtein('abc', 'abc')).toBe(0)
  })
  it('counts single edits correctly', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3)
  })
  it('handles empty strings', () => {
    expect(levenshtein('', 'abc')).toBe(3)
    expect(levenshtein('abc', '')).toBe(3)
  })
})

describe('fuzzyScore', () => {
  it('scores an exact match as 1', () => {
    expect(fuzzyScore('daft punk', 'daft punk')).toBe(1)
  })
  it('scores a substring match highly', () => {
    expect(fuzzyScore('punk', 'daft punk')).toBeGreaterThan(0.5)
  })
  it('scores unrelated strings low', () => {
    expect(fuzzyScore('xyz123', 'daft punk')).toBeLessThan(0.5)
  })
  it('returns 0 for empty input', () => {
    expect(fuzzyScore('', 'daft punk')).toBe(0)
    expect(fuzzyScore('daft punk', '')).toBe(0)
  })
})

describe('parseDurationString', () => {
  it('parses mm:ss', () => {
    expect(parseDurationString('3:45')).toBe(225)
  })
  it('parses h:mm:ss', () => {
    expect(parseDurationString('1:02:03')).toBe(3723)
  })
  it('rejects invalid seconds/minutes', () => {
    expect(parseDurationString('1:99')).toBeNull()
  })
  it('returns null for garbage input', () => {
    expect(parseDurationString('not a duration')).toBeNull()
  })
})

describe('formatSeconds', () => {
  it('formats under an hour as m:ss', () => {
    expect(formatSeconds(225)).toBe('3:45')
  })
  it('formats over an hour as h:mm:ss', () => {
    expect(formatSeconds(3723)).toBe('1:02:03')
  })
  it('round-trips with parseDurationString', () => {
    const seconds = 3723
    expect(parseDurationString(formatSeconds(seconds))).toBe(seconds)
  })
  it('clamps negative input to 0', () => {
    expect(formatSeconds(-5)).toBe('0:00')
  })
})

describe('formatFileSize', () => {
  it('formats bytes under 1KB as B', () => {
    expect(formatFileSize(512)).toBe('512 B')
  })
  it('formats larger sizes with a unit', () => {
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB')
  })
  it('returns a placeholder for invalid input', () => {
    expect(formatFileSize(-1)).toBe('—')
    expect(formatFileSize(NaN)).toBe('—')
  })
})
