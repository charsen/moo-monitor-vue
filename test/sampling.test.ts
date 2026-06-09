import { describe, it, expect } from 'vitest'
import { shouldSample, isIgnored } from '../src/core/sampling'

describe('shouldSample', () => {
  it('handles boundaries', () => {
    expect(shouldSample(1)).toBe(true)
    expect(shouldSample(2)).toBe(true)
    expect(shouldSample(0)).toBe(false)
    expect(shouldSample(-1)).toBe(false)
  })
})

describe('isIgnored', () => {
  it('matches string includes and regex', () => {
    expect(isIgnored('ResizeObserver loop limit exceeded', ['ResizeObserver'])).toBe(true)
    expect(isIgnored('Script error.', [/^Script error/])).toBe(true)
    expect(isIgnored('a real bug', ['ResizeObserver', /^Script error/])).toBe(false)
    expect(isIgnored('anything', [])).toBe(false)
  })
})
