import { describe, it, expect } from 'vitest'
import { Scope } from '../src/core/scope'

// 源自第九轮审查回归(Scope.setExtra 钳制)。
describe('① setExtra 钳制', () => {
  it('超大 extra 被占位替换;不可序列化不毒翻记录', () => {
    const s = new Scope()
    s.setExtra('snapshot', { big: 'x'.repeat(20000) })
    expect(s.extra.snapshot).toBe('[truncated: oversized extra]')

    const circular: Record<string, unknown> = {}
    circular.self = circular
    s.setExtra('loop', circular)
    expect(s.extra.loop).toBe('[unserializable extra]')

    s.setExtra('ok', { a: 1 }) // 正常值原样
    expect(s.extra.ok).toEqual({ a: 1 })
  })
})
