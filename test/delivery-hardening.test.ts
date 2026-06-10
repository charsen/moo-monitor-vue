// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { send } from '../src/core/transport'
import { Queue } from '../src/core/queue'
import type { FrontendErrorRecord } from '../src/core/types'

/**
 * 第六轮审查(可靠投递)回归:失败回收 / 卸载豁免退避 / 合并现场保鲜 / keepalive 配额。
 * 注意:退避是 transport 模块级状态,设退避(429)的用例必须排在文件最后,否则串染其余用例。
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

describe('失败回收与现场保鲜(不设退避的用例)', () => {
  it('同 hash 合并取最新现场(breadcrumbs/page),计数与 first_seen 仍正确', () => {
    const fetchMock = stubFetch(200)
    const q = new Queue(URL_, 'tok', 50, 20)
    q.add(
      rec('ffffffffffff', {
        first_seen: '2026-01-01T00:00:00Z', last_seen: '2026-01-01T00:00:00Z', count: 1,
        breadcrumbs: [{ category: 'click', message: '旧现场' }], page: { url: 'https://x/old' },
      }),
    )
    q.add(
      rec('ffffffffffff', {
        first_seen: '2026-01-01T00:00:05Z', last_seen: '2026-01-01T00:00:05Z', count: 1,
        breadcrumbs: [{ category: 'click', message: '新现场' }], page: { url: 'https://x/new' },
      }),
    )
    q.flush()

    const init = fetchMock.mock.calls[0][1] as unknown as RequestInit
    const sent = JSON.parse(init.body as string)
    expect(sent.records).toHaveLength(1)
    const merged = sent.records[0]
    expect(merged.count).toBe(2)                            // 计数累加
    expect(merged.first_seen).toBe('2026-01-01T00:00:00Z')  // 首见取最早
    expect(merged.last_seen).toBe('2026-01-01T00:00:05Z')   // 末见取最新
    expect(merged.breadcrumbs[0].message).toBe('新现场')     // 现场字段取最新一次发生
    expect(merged.page.url).toBe('https://x/new')
  })

  it('422 语义拒绝 → rejected;网络错 → network(transport.onFail)', async () => {
    stubFetch(422)
    const onFail = vi.fn()
    send(URL_, 'tok', [{ hash: 'b' }], { onFail })
    await settle()
    expect(onFail).toHaveBeenCalledWith([{ hash: 'b' }], 'rejected')

    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    const onFail2 = vi.fn()
    send(URL_, 'tok', [{ hash: 'c' }], { onFail: onFail2 })
    await settle()
    expect(onFail2).toHaveBeenCalledWith([{ hash: 'c' }], 'network')
  })

  it('Queue:网络失败的批回收重试一次,二次失败丢弃并经 onDrop 上抛', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    const drops: number[] = []
    const q = new Queue(URL_, 'tok', 50, 20, (n) => drops.push(n))

    q.add(rec('aaaaaaaaaaaa'))
    q.flush()
    await settle()
    expect(q.size()).toBe(1) // 失败回收回缓冲(此前这批人间蒸发)

    q.flush() // 第二次仍失败 → 丢弃计数
    await settle()
    expect(q.size()).toBe(0)

    q.add(rec('bbbbbbbbbbbb'))
    q.flush() // 下一轮 flush 前上报 dropped
    expect(drops).toEqual([1])
  })

  it('Queue:422 整批拒绝不重试、计入 dropped(此前完全静默)', async () => {
    stubFetch(422)
    const drops: number[] = []
    const q = new Queue(URL_, 'tok', 50, 20, (n) => drops.push(n))

    q.add(rec('cccccccccccc'))
    q.flush()
    await settle()
    expect(q.size()).toBe(0)

    q.add(rec('dddddddddddd'))
    q.flush()
    expect(drops).toEqual([1])
  })
})

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
