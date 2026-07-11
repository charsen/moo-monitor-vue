import { describe, it, expect } from 'vitest'
import { parseUA } from '../src/core/uaParse'

describe('parseUA', () => {
  it('detects Chrome on macOS desktop', () => {
    const r = parseUA(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    )
    expect(r.browser).toBe('Chrome')
    expect(r.os).toBe('macOS')
    expect(r.device).toBe('Desktop')
  })

  it('detects mobile Safari on iOS', () => {
    const r = parseUA(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    )
    expect(r.os).toBe('iOS')
    expect(r.device).toBe('Mobile')
  })

  it('detects Firefox on Windows', () => {
    const r = parseUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0')
    expect(r.browser).toBe('Firefox')
    expect(r.os).toBe('Windows')
  })

  it('detects Edge', () => {
    const r = parseUA(
      'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36 Edg/120.0',
    )
    expect(r.browser).toBe('Edge')
  })

  // 源自第七轮审查回归。
  it('iOS 上的 Chrome / Firefox 不再误判成 Safari(CriOS → Chrome;FxiOS → Firefox;真 Safari 不受影响)', () => {
    const crios = parseUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1')
    expect(crios.browser).toBe('Chrome')
    expect(crios.os).toBe('iOS')

    const fxios = parseUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15')
    expect(fxios.browser).toBe('Firefox')

    const safari = parseUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')
    expect(safari.browser).toBe('Safari')
  })
})
