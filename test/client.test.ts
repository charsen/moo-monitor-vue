import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MooClient } from '../src/core/client'
import type { FrontendErrorRecord } from '../src/core/types'

const OPTS = { endpoint: 'https://c.test/api/v1', token: 'tok12345', flushInterval: 50 }

describe('MooClient auto-capture', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'sendBeacon', { value: vi.fn(() => true), configurable: true })
  })

  it('captures global window error events and flushes via beacon', () => {
    const beacon = vi.fn(() => true)
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true })

    const client = new MooClient(OPTS)
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('global boom'), message: 'global boom' }))
    client.flush(true) // 用 beacon 路径(jsdom 无 fetch)

    expect(beacon).toHaveBeenCalled()
  })

  it('does not double-wrap window.fetch on repeated init', () => {
    const base = vi.fn(() => Promise.resolve({ ok: true, status: 200 }))
    // @ts-expect-error 测试注入 fetch
    window.fetch = base

    new MooClient(OPTS)
    const after1 = window.fetch
    expect((after1 as unknown as { __mooPatched?: boolean }).__mooPatched).toBe(true)

    new MooClient(OPTS)
    expect(window.fetch).toBe(after1) // 第二次 init 命中哨兵,不再叠加包裹
  })

  it('close() restores window.fetch and stops capturing (microfrontend / repeated init)', () => {
    const beacon = vi.fn(() => true)
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true })
    const base = vi.fn(() => Promise.resolve({ ok: true, status: 200 }))
    // @ts-expect-error 测试注入 fetch
    window.fetch = base

    const client = new MooClient(OPTS)
    expect(window.fetch).not.toBe(base) // 已打补丁

    client.close()
    expect(window.fetch).toBe(base) // 还原原始 fetch

    beacon.mockClear()
    client.captureException(new Error('after close')) // 关闭后 enabled=false → 不入队
    client.flush(true)
    expect(beacon).not.toHaveBeenCalled()
  })

  it('flushes the queue on pagehide', () => {
    const beacon = vi.fn(() => true)
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true })

    const client = new MooClient(OPTS)
    client.captureException(new Error('queued before unload'))
    window.dispatchEvent(new Event('pagehide'))

    expect(beacon).toHaveBeenCalled()
  })

  it('respects enabled=false (no capture)', () => {
    const beacon = vi.fn(() => true)
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true })

    const client = new MooClient({ ...OPTS, enabled: false })
    client.captureException(new Error('should be ignored'))
    client.flush()

    expect(beacon).not.toHaveBeenCalled()
  })

  it('releaseCheck reports missing sourcemaps through onError only', async () => {
    const onError = vi.fn()
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true, vip: true, health: { artifact_count: 0 } }), { status: 200 })),
    )
    // @ts-expect-error 测试注入 fetch
    window.fetch = fetchMock

    // P0.1 后 autoBreadcrumbs:false 仍会打 fetch/XHR 补丁(httpErrors 默认开)→ 必须 close(),
    // 否则 __mooPatched 哨兵与 XHR 原型补丁残留会污染后续用例。
    const client = new MooClient({ ...OPTS, release: 'v1-aabbccdd', autoBreadcrumbs: false, releaseCheck: true, onError })
    expect(fetchMock).toHaveBeenCalledWith('https://c.test/api/v1/sourcemaps/check', expect.objectContaining({ method: 'POST' }))
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('has no sourcemap artifacts') })))
    client.close()
  })
})

// 源自第七轮审查回归(MooClient 相关用例;Queue/normalize/uaParse/vue 部分已归入各自模块文件)。
describe('第七轮审查回归(MooClient)', () => {
  const clients: MooClient[] = []
  const makeClient = (extra: Record<string, unknown> = {}) => {
    const records: FrontendErrorRecord[] = []
    const client = new MooClient({
      endpoint: 'https://c.test/api/v1', token: 'tok12345',
      beforeSend: (e) => (records.push(e), null),
      ...extra,
    })
    clients.push(client)
    return { client, records }
  }
  beforeEach(() => {
    document.body.innerHTML = ''
  })
  afterEach(() => {
    clients.splice(0).forEach((c) => c.close())
    vi.unstubAllGlobals()
  })

  describe('① captureMessage / 资源错误不再携带 SDK 内部栈', () => {
    it('captureMessage:无 frames、name=Message(此前指纹/位置全是监控代码)', () => {
      const { client, records } = makeClient()
      client.captureMessage('支付回调超时', 'warning')

      expect(records[0].error.name).toBe('Message')
      expect(records[0].frames).toBeUndefined()
      expect(records[0].error.stack).toBeUndefined()
    })

    it('资源加载失败:name=ResourceError、无 frames', () => {
      const { records } = makeClient()
      document.body.innerHTML = '<img src="https://cdn.test/x.png">'
      document.querySelector('img')!.dispatchEvent(new Event('error'))

      const r = records.find((x) => x.error.name === 'ResourceError')
      expect(r?.error.message).toContain('x.png')
      expect(r?.frames).toBeUndefined()
    })
  })

  describe('⑤ close() 释放 DOM 引用', () => {
    // 拆分后 lastInputEl / lastFetch 是插桩模块的闭包私有态(不再是 client 字段),按方案 2.4 第 6 条
    // 改为可观测行为断言:聚合命中 + close 后不再记轨迹 / 不再捕获(监听解绑 + 闭包持有的节点随之释放)。
    it('输入聚合命中;close() 后解绑监听、不再记录/捕获(不滞留已脱离的 DOM 节点)', () => {
      const { client, records } = makeClient()
      document.body.innerHTML = '<input name="q">'
      const input = document.querySelector('input')!
      // 同一元素连续两次 keydown 聚合成一条(lastInputEl 命中)
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }))
      client.captureException(new Error('probe'))
      const inputs = (records[records.length - 1].breadcrumbs ?? []).filter((b) => b.category === 'input')
      expect(inputs).toHaveLength(1) // 两次打字只一条(聚合态生效)

      client.close() // 解绑 click/keydown 监听 + 释放闭包持有的 lastInputEl
      const n = records.length
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true })) // 监听已解绑,无副作用
      client.captureException(new Error('after')) // enabled=false → 不入队
      expect(records.length).toBe(n) // 关闭后不再捕获、无残留监听触发
    })
  })

  describe('⑥ setTag 钳制', () => {
    it('超长 tag 值截到 200(不再把每条记录顶到截断线)', () => {
      const { client, records } = makeClient()
      client.setTag('cfg', 'x'.repeat(5000))
      client.captureException(new Error('boom'))

      const tags = records[0].payload?.tags as Record<string, string>
      expect(tags.cfg.length).toBe(200)
    })
  })
})
