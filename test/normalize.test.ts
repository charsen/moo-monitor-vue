import { describe, it, expect } from 'vitest'
import { normalize, toError } from '../src/core/normalize'

describe('toError', () => {
  it('coerces non-Error throws', () => {
    expect(toError('str').message).toBe('str')
    expect(toError({ a: 1 }).message).toContain('a')
    expect(toError(null).message).toBeDefined()
    expect(toError(new RangeError('r'))).toBeInstanceOf(RangeError)
  })

  it('uses a thrown object’s own message/name', () => {
    const e = toError({ message: 'custom boom', name: 'ApiError' })
    expect(e.message).toBe('custom boom')
    expect(e.name).toBe('ApiError')
  })

  it('survives circular references without collapsing to Unknown error', () => {
    const a: Record<string, unknown> = {}
    a.self = a
    const e = toError(a)
    expect(e.message).toContain('Circular')
    expect(e.message).not.toBe('Unknown error')
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

  it('sets first_seen (for cloud new-record first-seen)', () => {
    expect(normalize(new Error('x'), {}).first_seen).toBeDefined()
  })

  it('normalizes volatile numbers/ids so they group together', () => {
    const a = normalize(new Error('failed for user 123 at 0xABCD'), {})
    const b = normalize(new Error('failed for user 456 at 0x1234'), {})
    expect(a.hash).toBe(b.hash)
  })

  it('keeps distinct quoted property names in different groups', () => {
    const a = normalize(new Error("Cannot read properties of undefined (reading 'id')"), {})
    const b = normalize(new Error("Cannot read properties of undefined (reading 'name')"), {})
    expect(a.hash).not.toBe(b.hash)
  })

  it('strips SDK-internal frames but keeps app frames', () => {
    const err = new Error('boom')
    err.stack =
      'Error: boom\n    at toError (http://x/node_modules/.vite/deps/moo-monitor-vue_vue.js:1:1)\n    at handler (http://app/Cart.vue:42:5)'
    const rec = normalize(err, {})
    expect(rec.frames?.some((f) => f.file?.includes('moo-monitor-vue'))).toBeFalsy()
    expect(rec.frames?.some((f) => f.file?.includes('Cart.vue'))).toBe(true)
    expect(rec.error.stack).not.toContain('moo-monitor-vue')
  })

  it('falls back to onerror location frame when only SDK frames remain', () => {
    const err = new Error('ResizeObserver loop')
    err.stack =
      'Error: ResizeObserver loop\n    at toError (http://x/moo-monitor-vue_vue.js:1:1)\n    at normalize (http://x/moo-monitor-vue_vue.js:2:2)'
    const rec = normalize(err, { location: { file: 'http://app/page.js', line: 10, column: 3 } })
    expect(rec.frames).toEqual([{ file: 'http://app/page.js', line: 10, column: 3 }])
  })
})
