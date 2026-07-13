// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { send } from '../src/core/transport'
import { Queue } from '../src/core/queue'
import type { FrontendErrorRecord } from '../src/core/types'

/**
 * 第六轮审查(可靠投递)的退避语义回归 —— 429 把触发批还给调用方 + 卸载 beacon 豁免退避。
 * 退避是 transport 模块级状态:这两个用例都要求「进入时退避为假」,与 transport.test 里已有的 429 用例
 * 互斥(同一进程内谁先设退避,另一个就跑不成),故单列一个文件靠 vitest 的文件级隔离各自持有干净的退避态。
 */

const URL_ = 'https://cloud.test/api/v1/frontend-errors/intake'

const rec = (hash: string, extra: Partial<FrontendErrorRecord> = {}): FrontendErrorRecord =>
  ({
    hash,
    error: { name: 'E', message: 'm', handled: false, severity: 'error' },
    page: {},
    client: {},
    context: {},
    ...extra,
  }) as FrontendErrorRecord

function stubFetch(status: number, retryAfter: string | null = null) {
  const fetchMock = vi.fn(() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h: string) => (h === 'Retry-After' ? retryAfter : null) },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => vi.unstubAllGlobals())

describe('退避语义(设退避,须在文件最后)', () => {
  it('429:设退避并把触发批还给调用方(rate_limited)', async () => {
    stubFetch(429, '120')
    const onFail = vi.fn()
    send(URL_, 'tok', [{ hash: 'a' }], { onFail })
    await settle()

    expect(onFail).toHaveBeenCalledWith([{ hash: 'a' }], 'rate_limited')
  })

  it('退避中页面卸载:beacon 豁免退避发出缓冲(此前整缓冲随页面死掉)', () => {
    // 上一用例已进入 120s 退避。
    const beacon = vi.fn(() => true)
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true })
    const q = new Queue(URL_, 'tok', 50, 20)
    q.add(rec('eeeeeeeeeeee'))

    expect(q.flush(false)).toBe(false) // 常态路径仍尊重退避
    expect(beacon).not.toHaveBeenCalled()

    expect(q.flush(true)).toBe(true) // 卸载路径:一次性 beacon 豁免
    expect(beacon).toHaveBeenCalledOnce()
  })
})
