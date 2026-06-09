import { describe, it, expect } from 'vitest'
import { scrub } from '../src/core/scrub'

describe('scrub', () => {
  it('masks token / access_token key-values but keeps benign params', () => {
    expect(scrub('http://a/x?token=abc123')).toBe('http://a/x?token=***')
    expect(scrub('http://a/x?page=2&access_token=secret')).toBe('http://a/x?page=2&access_token=***')
  })

  it('masks JWT and Bearer', () => {
    expect(scrub('called with Bearer xyz.abc-_1 here')).toContain('Bearer ***')
    expect(scrub('eyJhbGciOi.eyJzdWIiOi.SflKxwRJ')).toBe('***JWT***')
  })

  it('leaves non-secret text untouched + passes through empty/undefined', () => {
    expect(scrub('GET /api/users?page=2 200')).toBe('GET /api/users?page=2 200')
    expect(scrub(undefined)).toBeUndefined()
    expect(scrub('')).toBe('')
  })
})
