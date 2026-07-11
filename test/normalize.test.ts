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

  it('keeps the real stack for genuine Error throws', () => {
    const err = new Error('boom')
    err.stack = 'Error: boom\n    at handler (http://app/Cart.vue:42:5)'
    const rec = normalize(err, {})
    expect(rec.frames?.some((f) => f.file?.includes('Cart.vue'))).toBe(true)
    expect(rec.error.stack).toContain('Cart.vue')
  })

  it('discards the SDK-synthesized stack for non-Error throws and uses onerror location', () => {
    // 字符串抛值 → Error 在 SDK 内合成,栈是 SDK 内部 → 应丢弃(与打包文件名无关),用 location 补帧。
    const rec = normalize('boom from a string throw', { location: { file: 'http://app/page.js', line: 10, column: 3 } })
    expect(rec.frames).toEqual([{ file: 'http://app/page.js', line: 10, column: 3 }])
    expect(rec.error.stack).toBeUndefined()
  })

  it('redacts secrets in message / stack / page / breadcrumbs before sending (defense in depth)', () => {
    const err = new Error('请求失败 GET http://api/x?token=msgsecret777')
    err.stack = 'Error: boom\n    at f (http://app/x.js?token=topsecret123:1:1)'
    const rec = normalize(err, {
      breadcrumbs: [{ category: 'fetch', message: 'GET http://api/u?access_token=leaked999 200' }],
    })
    const json = JSON.stringify(rec)
    expect(rec.error.message).not.toContain('msgsecret777') // error.message 也脱敏
    expect(json).not.toContain('msgsecret777')
    expect(json).not.toContain('topsecret123')
    expect(json).not.toContain('leaked999')
  })
})

// 源自第七轮审查回归(指纹跨发版稳定,归入 normalize 模块)。
describe('② 指纹跨发版稳定(剥离产物内容 hash)', () => {
  const withStack = (file: string) => {
    const e = new Error('boom')
    e.stack = `Error: boom\n    at render (https://x.test/assets/${file}:1:100)`
    return e
  }

  it('同一错误在两次发版(产物名 hash 轮换)间指纹一致', () => {
    const a = normalize(withStack('index-DfA3k2Lz.js'), {})
    const b = normalize(withStack('index-Xy9Qw8Mn.js'), {})
    expect(a.hash).toBe(b.hash)

    // 语义后缀(-legacy / .min,< 8 位)不受影响,仍参与区分
    const legacy = normalize(withStack('main-legacy.js'), {})
    const modern = normalize(withStack('main.js'), {})
    expect(legacy.hash).not.toBe(modern.hash)
  })
})

// 源自第九轮审查回归(stableFile 不误伤人工命名,兼容 .min.js)。
describe('④ stableFile:不误伤人工命名,兼容 .min.js', () => {
  const withStack = (file: string) => {
    const e = new Error('boom')
    e.stack = `Error: boom\n    at render (https://x.test/assets/${file}:1:100)`
    return e
  }

  it('user-settings.js(无数字)不再被剥;.min.js 带 hash 的也能剥', () => {
    // 人工命名:settings 段无数字 → 保留,与真 user.js 指纹不同
    expect(normalize(withStack('user-settings.js'), {}).hash).not.toBe(normalize(withStack('user.js'), {}).hash)
    // .min.js:hash 段照剥 → 跨发版稳定
    expect(normalize(withStack('app-Df3kZ2L0.min.js'), {}).hash).toBe(normalize(withStack('app-Aa1Bb2Cc.min.js'), {}).hash)
  })
})
