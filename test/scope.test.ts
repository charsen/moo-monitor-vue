import { describe, it, expect } from 'vitest'
import { Scope } from '../src/core/scope'

// 源自第九轮审查回归(Scope.setExtra 钳制)。
describe('① setExtra 钳制', () => {
  it('extra 先有界清洗和冻结；大对象与循环引用不会毒翻记录', () => {
    const s = new Scope()
    s.setExtra('snapshot', { big: 'x'.repeat(20000) })
    expect((s.extra.snapshot as { big: string }).big.length).toBeLessThanOrEqual(1024)

    const circular: Record<string, unknown> = {}
    circular.self = circular
    s.setExtra('loop', circular)
    expect(() => JSON.stringify(s.extra.loop)).not.toThrow()
    expect(JSON.stringify(s.extra.loop)).toContain('[truncated]')

    s.setExtra('ok', { a: 1 }) // 正常值原样
    expect(s.extra.ok).toEqual({ a: 1 })
  })
  it('特殊键不改变原型，敏感值和截断 JWT 不会残留', () => {
    const s = new Scope()
    s.setExtra('__proto__', { polluted: true })
    expect(Object.getPrototypeOf(s.extra)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    s.setTag('token', 'tag-secret')
    s.setExtra('note', 'eyJ' + 'A'.repeat(40_000) + '.payload.signature')
    expect(JSON.stringify({ tags: s.tags, extra: s.extra })).not.toContain('tag-secret')
    expect(JSON.stringify(s.extra)).not.toContain('eyJAAA')
  })
  it('长度预算不会截出孤立UTF16代理', () => {
    const s = new Scope()
    s.setTag('unicode', 'a'.repeat(199) + '😀')
    s.setExtra('unicode', 'a'.repeat(1023) + '😀')
    expect(JSON.stringify(s.tags)).not.toContain('\\ud83d')
    expect(JSON.stringify(s.extra)).not.toContain('\\ud83d')
  })
})
