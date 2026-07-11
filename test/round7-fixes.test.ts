// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MooClient } from '../src/core/client'
import { normalize } from '../src/core/normalize'
import { parseUA } from '../src/core/uaParse'
import { Queue } from '../src/core/queue'
import MooMonitor from '../src/vue/plugin'
import type { FrontendErrorRecord } from '../src/core/types'

/** 第七轮审查回归:6 个问题的逐一验证。 */

const clients: MooClient[] = []
function makeClient(extra: Record<string, unknown> = {}) {
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

describe('③ iOS 上的 Chrome / Firefox 不再误判成 Safari', () => {
  it('CriOS → Chrome;FxiOS → Firefox;真 Safari 不受影响', () => {
    const crios = parseUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1')
    expect(crios.browser).toBe('Chrome')
    expect(crios.os).toBe('iOS')

    const fxios = parseUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15')
    expect(fxios.browser).toBe('Firefox')

    const safari = parseUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')
    expect(safari.browser).toBe('Safari')
  })
})

describe('④ Vue Router 错误不再双重捕获', () => {
  it('router.onError 捕获后,同一 Error 进 unhandledrejection 被跳过', () => {
    const records: FrontendErrorRecord[] = []
    let routerHandler: ((e: unknown) => void) | undefined
    const app = { provide: vi.fn(), config: { globalProperties: {} as Record<string, unknown>, errorHandler: undefined } }
    ;(MooMonitor as { install: (a: unknown, o: unknown) => void }).install(app, {
      endpoint: 'https://c.test/api/v1', token: 'tok12345',
      beforeSend: (e: FrontendErrorRecord) => (records.push(e), null),
      router: { onError: (h: (e: unknown) => void) => (routerHandler = h) },
    })

    const chunkErr = new Error('Loading chunk 12 failed')
    routerHandler!(chunkErr) // router.onError 先捕获并打标
    const ev = new Event('unhandledrejection')
    ;(ev as unknown as { reason: unknown }).reason = chunkErr
    window.dispatchEvent(ev) // 同一 Error 的未捕获拒绝随后到达

    expect(records).toHaveLength(1) // 此前会是 2(count 翻倍)
    // 其他 rejection 照常捕获
    const ev2 = new Event('unhandledrejection')
    ;(ev2 as unknown as { reason: unknown }).reason = new Error('other')
    window.dispatchEvent(ev2)
    expect(records).toHaveLength(2)
  })
})

describe('⑤ 重试标记随合并延续 + close() 释放 DOM 引用', () => {
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
