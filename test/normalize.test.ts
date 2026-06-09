import { describe, it, expect } from 'vitest'
import { normalize, toError } from '../src/core/normalize'

describe('toError', () => {
  it('coerces non-Error throws', () => {
    expect(toError('str').message).toBe('str')
    expect(toError({ a: 1 }).message).toContain('a')
    expect(toError(null).message).toBeDefined()
    expect(toError(new RangeError('r'))).toBeInstanceOf(RangeError)
  })
})

describe('normalize', () => {
  it('maps an Error into the cloud record shape', () => {
    const rec = normalize(new TypeError('boom'), { env: 'production', release: '1.0.0', project: 'web', handled: false })
    expect(rec.hash).toMatch(/^[a-f0-9]{12}$/)
    expect(rec.error.name).toBe('TypeError')
    expect(rec.error.message).toBe('boom')
    expect(rec.error.handled).toBe(false)
    expect(rec.context.env).toBe('production')
    expect(rec.context.release).toBe('1.0.0')
    expect(rec.context.project).toBe('web')
    expect(rec.last_seen).toBeDefined()
  })

  it('defaults project to web and handled to true', () => {
    const rec = normalize(new Error('x'), {})
    expect(rec.context.project).toBe('web')
    expect(rec.error.handled).toBe(true)
  })

  it('groups identical errors under the same hash', () => {
    const a = normalize(new Error('Cannot read id of undefined'), {})
    const b = normalize(new Error('Cannot read id of undefined'), {})
    expect(a.hash).toBe(b.hash)
  })

  it('packs tags/extra into payload, omits when empty', () => {
    const rec = normalize(new Error('x'), { tags: { area: 'checkout' }, extra: { cartId: 'c1' } })
    expect(rec.payload?.tags).toEqual({ area: 'checkout' })
    expect(rec.payload?.extra).toEqual({ cartId: 'c1' })
    expect(normalize(new Error('y'), {}).payload).toBeUndefined()
  })
})
