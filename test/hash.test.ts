import { describe, it, expect } from 'vitest'
import { hash12 } from '../src/core/hash'

describe('hash12', () => {
  it('returns 12 lowercase hex chars (matches cloud regex)', () => {
    expect(hash12('hello')).toMatch(/^[a-f0-9]{12}$/)
    expect(hash12('')).toMatch(/^[a-f0-9]{12}$/)
    expect(hash12('TypeError\nCannot read x\napp.js:render')).toMatch(/^[a-f0-9]{12}$/)
  })

  it('is deterministic for the same input', () => {
    expect(hash12('TypeError\nfoo')).toBe(hash12('TypeError\nfoo'))
  })

  it('differs for different inputs', () => {
    expect(hash12('a')).not.toBe(hash12('b'))
    expect(hash12('TypeError\nfoo')).not.toBe(hash12('TypeError\nbar'))
  })
})
