import { describe, it, expect } from 'vitest'
import { parseStack } from '../src/core/stacktrace'

describe('parseStack', () => {
  it('parses Chrome frames (with and without function)', () => {
    const s = 'TypeError: x\n    at foo (https://a.com/app.js:10:5)\n    at https://a.com/app.js:20:1'
    const f = parseStack(s)
    expect(f[0]).toEqual({ function: 'foo', file: 'https://a.com/app.js', line: 10, column: 5 })
    expect(f[1].file).toBe('https://a.com/app.js')
    expect(f[1].line).toBe(20)
  })

  it('parses Firefox/Safari frames', () => {
    const f = parseStack('foo@https://a.com/app.js:10:5')
    expect(f[0]).toMatchObject({ function: 'foo', line: 10, column: 5 })
  })

  it('marks eval frames as file=eval (no inner-location leak)', () => {
    const f = parseStack('Error\n    at eval (eval at <anonymous> (app.js:1:1), <anonymous>:2:3)')
    expect(f[0].file).toBe('eval')
  })

  it('keeps native frames as function-only instead of dropping them', () => {
    const f = parseStack('Error\n    at Array.forEach (native)')
    expect(f[0].file).toBe('native')
    expect(f[0].function).toContain('forEach')
  })

  it('returns [] for empty / non-string input', () => {
    expect(parseStack(undefined)).toEqual([])
    expect(parseStack('')).toEqual([])
  })
})

// 源自第八轮审查回归(无列号帧解析)。
describe('⑥ 无列号帧解析', () => {
  it('"at file:line" 解析成 file+line 帧,不再把 URL 当函数名', () => {
    const frames = parseStack('Error: x\n    at https://x.test/app.js:10\n    at run (https://x.test/app.js:22)\n    at fn (native)')
    expect(frames[0]).toEqual({ function: '?', file: 'https://x.test/app.js', line: 10 })
    expect(frames[1]).toEqual({ function: 'run', file: 'https://x.test/app.js', line: 22 })
    expect(frames[2]).toEqual({ function: 'fn', file: 'native' }) // native 兜底不受影响
  })
})
