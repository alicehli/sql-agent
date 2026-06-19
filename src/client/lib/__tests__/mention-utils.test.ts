import { describe, expect, it } from 'vitest'
import {
  findRangeMatch,
  removeRange,
  replaceRangeWithValue,
  type TextRangeMatch,
} from '../mention-utils'

const SLASH_PATTERN = /(?:^|\s)\/[^\s/]*/gm
const AT_PATTERN = /(?:^|\s)@[^\s]*/gm

describe('findRangeMatch', () => {
  it('returns undefined when the cursor offset is unknown', () => {
    expect(findRangeMatch('/foo', undefined, SLASH_PATTERN, '/')).toBeUndefined()
  })

  it('matches a slash token the caret sits inside and extracts the query', () => {
    const source = '/compact'
    const match = findRangeMatch(source, source.length, SLASH_PATTERN, '/')
    expect(match).toEqual<TextRangeMatch>({ query: 'compact', start: 0, end: 8 })
  })

  it('matches a mention in the middle of text using the trigger position', () => {
    const source = 'hello @wor'
    const match = findRangeMatch(source, source.length, AT_PATTERN, '@')
    // The trigger '@' is at index 6 (after "hello "), query is everything after it.
    expect(match).toEqual<TextRangeMatch>({ query: 'wor', start: 6, end: 10 })
  })

  it('returns undefined when the caret is outside every token', () => {
    const source = '/foo bar'
    // Caret at the very end sits inside "bar", not the slash token.
    expect(findRangeMatch(source, source.length, SLASH_PATTERN, '/')).toBeUndefined()
  })
})

describe('replaceRangeWithValue', () => {
  it('replaces the range and appends a space when none follows', () => {
    const range: TextRangeMatch = { query: 'co', start: 0, end: 3 }
    expect(replaceRangeWithValue('/co', range, 'compact')).toBe('compact ')
  })

  it('keeps the trigger char when includeTrigger is set and preserves a trailing space', () => {
    const source = 'see @jo end'
    const range: TextRangeMatch = { query: 'jo', start: 4, end: 7 }
    expect(replaceRangeWithValue(source, range, 'john', true)).toBe('see @john end')
  })
})

describe('removeRange', () => {
  it('removes exactly the matched range', () => {
    const range: TextRangeMatch = { query: 'foo', start: 6, end: 10 }
    expect(removeRange('hello @foo', range)).toBe('hello ')
  })
})
