import { describe, it, expect, vi, afterEach } from 'vitest'
import { send, inBackoff } from '../src/core/transport'
import { Queue } from '../src/core/queue'
import type { FrontendErrorRecord } from '../src/core/types'

const URL_ = 'https://cloud.test/api/v1/frontend-errors/intake'

describe('transport.send', () => {
  it('uses sendBeacon when useBeacon=true (页面卸载)', () => {
    const beacon = vi.fn(() => true)
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true })

    const ok = send(URL_, 'tok123', [{ hash: 'aaaaaaaaaaaa' }], { useBeacon: true })

    expect(ok).toBe(true)
    expect(beacon).toHaveBeenCalledOnce()
    expect(beacon.mock.calls[0][0]).toBe(URL_)
    expect(beacon.mock.calls[0][1]).toBeInstanceOf(Blob)
  })

  it('uses fetch (readable) by default with only Content-Type header', () => {
    const fetchMock = vi.fn(() => Promise.resolve({ status: 200, headers: { get: () => null } }))
    vi.stubGlobal('fetch', fetchMock)

    const ok = send(URL_, 'tok123', [{ hash: 'bbbbbbbbbbbb' }])

    expect(ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledOnce()
    const opts = fetchMock.mock.calls[0][1] as RequestInit
    expect(opts.method).toBe('POST')
    expect(opts.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(opts.keepalive).toBe(false) // 常态周期不用 keepalive:其 64KB 配额是全部在途请求共享的
    expect(opts.credentials).toBe('omit')
    const body = JSON.parse(opts.body as string)
    expect(body.token).toBe('tok123')
    expect(body.records[0].hash).toBe('bbbbbbbbbbbb')

    vi.unstubAllGlobals()
  })
})

// 真实 transport × Queue 的投递硬化回归 —— queue.test.ts 的 Queue 用例走 vi.mock 的假 transport(测队列逻辑),
// 这里走真 transport(stub fetch,测投递集成)。设退避(429)的用例集中在文件最后的「退避语义」describe。
describe('投递硬化:重试标记随合并延续(源自第7轮)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('回收中的记录与新发生合并后,二次失败即丢弃(不无限重试)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    const drops: number[] = []
    const q = new Queue('https://c.test/api/v1/x', 'tok', 50, 20, (n) => drops.push(n))
    const rec = { hash: 'h1', error: { name: 'E', message: 'm', handled: false, severity: 'error' }, page: {}, client: {}, context: {} } as FrontendErrorRecord

    q.add({ ...rec })
    q.flush()
    await Promise.resolve(); await Promise.resolve()
    expect(q.size()).toBe(1)      // 失败回收(第一次重试机会)

    q.add({ ...rec, count: 1 })   // 错误仍在发生:与回收中的记录合并(新对象)
    q.flush()
    await Promise.resolve(); await Promise.resolve()
    expect(q.size()).toBe(0)      // 标记延续 → 二次失败丢弃,而非再次回收
  })
})

// 源自第8轮审查回归(缓冲上限 / 超大记录裁剪,真 transport)。
describe('投递硬化:缓冲上限与超大记录(源自第8轮)', () => {
  const rec = (hash: string, extra: Partial<FrontendErrorRecord> = {}): FrontendErrorRecord =>
    ({ hash, error: { name: 'E', message: 'm', handled: false, severity: 'error' }, page: {}, client: {}, context: {}, ...extra }) as FrontendErrorRecord
  afterEach(() => vi.unstubAllGlobals())

  it('缓冲满:溢出后缓冲里是最新的 200 条(此前留最旧丢最新)', () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200, headers: { get: () => null } }))
    vi.stubGlobal('fetch', fetchMock)
    const q = new Queue('https://c.test/x', 'tok', 999999, 999999) // 不自动 flush
    for (let i = 0; i < 205; i++) q.add(rec(`h${String(i).padStart(10, '0')}`))

    expect(q.size()).toBe(200)
    q.flush()
    const sent: FrontendErrorRecord[] = []
    for (const call of fetchMock.mock.calls) {
      sent.push(...JSON.parse((call[1] as RequestInit).body as string).records)
    }
    const hashes = sent.map((r) => r.hash)
    expect(hashes).toContain('h0000000204') // 最新的还在
    expect(hashes).not.toContain('h0000000000') // 最旧的被挤掉
  })

  it('超大记录:url 纳入裁剪;仍超限则丢弃不再发', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200, headers: { get: () => null } }))
    vi.stubGlobal('fetch', fetchMock)
    const drops: number[] = []
    const q = new Queue('https://c.test/x', 'tok', 999999, 999999, (n) => drops.push(n))

    q.add(rec('aaaaaaaaaaaa', { page: { url: 'https://x/?q=' + 'a'.repeat(60000) } }))
    // beforeSend 注入巨型不可裁剪字段(顶层自定义键,truncateRecord 两轮都不会动它)
    q.add(rec('bbbbbbbbbbbb', { user: { name: 'x'.repeat(60000) } } as never))
    q.flush()

    const sent: FrontendErrorRecord[] = []
    for (const call of fetchMock.mock.calls) {
      sent.push(...JSON.parse((call[1] as RequestInit).body as string).records)
    }
    const a = sent.find((r) => r.hash === 'aaaaaaaaaaaa')
    expect(a?.page.url?.length).toBeLessThanOrEqual(2048) // url 截断后照发
    expect(sent.find((r) => r.hash === 'bbbbbbbbbbbb')).toBeUndefined() // 不可救的丢弃

    q.add(rec('cccccccccccc'))
    q.flush() // 下一轮上报 dropped
    expect(drops).toEqual([1])
  })
})

// 源自第9轮审查回归(截断分级丢弃 / 滞留路径补 arm,真 transport)。
describe('投递硬化:分级截断与滞留补 arm(源自第9轮)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('截断二轮先丢 payload,frames/breadcrumbs 得以保住', () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200, headers: { get: () => null } }))
    vi.stubGlobal('fetch', fetchMock)
    const q = new Queue('https://c.test/x', 'tok', 999999, 999999)
    q.add({
      hash: 'aaaaaaaaaaaa',
      error: { name: 'E', message: 'm', handled: false, severity: 'error' },
      page: {}, client: {}, context: {},
      frames: [{ file: 'app.js', line: 1, column: 1, function: 'f' }],
      breadcrumbs: [{ category: 'click', message: 'b' }],
      payload: { extra: { huge: 'x'.repeat(60000) } }, // 肇事者是 payload
    } as FrontendErrorRecord)
    q.flush()

    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).records[0]
    expect(sent.payload).toBeUndefined()       // 只丢 payload
    expect(sent.frames).toBeTruthy()           // 栈保住了(此前连坐被丢)
    expect(sent.breadcrumbs).toBeTruthy()      // 轨迹保住了
  })

  it('422 丢弃后自动安排下一轮 flush,onDrop 不需要等新错误才响', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 422, headers: { get: () => null } })))
    const drops: number[] = []
    const q = new Queue('https://c.test/x', 'tok', 50, 20, (n) => drops.push(n))
    q.add({ hash: 'aaaaaaaaaaaa', error: { name: 'E', message: 'm', handled: false, severity: 'error' }, page: {}, client: {}, context: {} } as FrontendErrorRecord)
    q.flush()
    await vi.advanceTimersByTimeAsync(10) // 让 fetch then 落地(rejected → dropped+arm)
    await vi.advanceTimersByTimeAsync(60) // 到点自动 flush → 上报 dropped
    expect(drops).toEqual([1])
    vi.useRealTimers()
  })
})

// 退避是 transport 模块级状态:设退避(429)的用例必须排在文件最后,否则串染其余用例。
describe('退避语义(设退避,须在文件最后)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('enters backoff on 429 (Retry-After) and drops subsequent sends until it elapses', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ status: 429, headers: { get: (h: string) => (h === 'Retry-After' ? '120' : null) } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    expect(inBackoff()).toBe(false)
    send(URL_, 'tok', [{ hash: 'cccccccccccc' }]) // 派发,异步读到 429 → 设退避
    await Promise.resolve()
    await Promise.resolve()
    expect(inBackoff()).toBe(true)

    // 退避中:再发直接丢弃,不再打 fetch。
    fetchMock.mockClear()
    const ok = send(URL_, 'tok', [{ hash: 'dddddddddddd' }])
    expect(ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
