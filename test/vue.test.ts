import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, h } from 'vue'
import { MooMonitor } from '../src/vue/plugin'
import { getClient } from '../src/core/client'
import type { FrontendErrorRecord } from '../src/core/types'

describe('MooMonitor (Vue plugin)', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'sendBeacon', { value: vi.fn(() => true), configurable: true })
  })

  it('install takes over app.config.errorHandler and captures through it', () => {
    const app = createApp({ render: () => h('div') })
    app.use(MooMonitor, { endpoint: 'https://cloud.test/api/v1', token: 'tok12345', flushInterval: 10 })

    expect(typeof app.config.errorHandler).toBe('function')

    const client = getClient()!
    const spy = vi.spyOn(client, 'captureException')
    app.config.errorHandler!(new Error('vue boom'), null, 'render')
    expect(spy).toHaveBeenCalledOnce()
  })

  it('preserves a previously-registered errorHandler', () => {
    const app = createApp({ render: () => h('div') })
    const prev = vi.fn()
    app.config.errorHandler = prev
    app.use(MooMonitor, { endpoint: 'https://cloud.test/api/v1', token: 'tok12345' })

    app.config.errorHandler!(new Error('x'), null, 'render')
    expect(prev).toHaveBeenCalledOnce()
  })

  it('captures router lazy-load (chunk) failures via router.onError', () => {
    let handler: ((e: unknown) => void) | undefined
    const router = { onError: (h: (e: unknown) => void) => { handler = h } }

    const app = createApp({ render: () => h('div') })
    app.use(MooMonitor, { endpoint: 'https://cloud.test/api/v1', token: 'tok12345', router })

    expect(typeof handler).toBe('function')
    const client = getClient()!
    const spy = vi.spyOn(client, 'captureException')
    handler!(new Error('Loading chunk 5 failed'))
    expect(spy).toHaveBeenCalledOnce()
  })

  it('flush() sends queued events via beacon', () => {
    const beacon = vi.fn(() => true)
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true })

    const app = createApp({ render: () => h('div') })
    app.use(MooMonitor, { endpoint: 'https://cloud.test/api/v1', token: 'tok12345' })

    const client = getClient()!
    client.captureException(new Error('manual report'))
    client.flush(true) // beacon 路径(jsdom 无 fetch)

    expect(beacon).toHaveBeenCalled()
  })
})

describe('SSR(无 window)', () => {
  it('provide / $moo 注入先于 SSR 判断:服务端 setup 里 inject 也拿得到客户端实例', () => {
    vi.stubGlobal('window', undefined) // typeof window === 'undefined'
    try {
      const provide = vi.fn()
      const app = {
        provide,
        config: { globalProperties: {} as Record<string, unknown>, errorHandler: undefined },
      }
      ;(MooMonitor as { install: (app: unknown, o: unknown) => void }).install(app, {
        endpoint: 'https://cloud.test/api/v1',
        token: 'tok12345',
      })

      expect(provide).toHaveBeenCalledWith('mooMonitor', expect.anything())
      expect(app.config.globalProperties.$moo).toBeTruthy()
      expect(app.config.errorHandler).toBeUndefined() // 浏览器侧捕获仍不接管
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// 源自第七轮审查回归(Vue Router 双重捕获,归入 vue 插件模块)。
describe('④ Vue Router 错误不再双重捕获', () => {
  afterEach(() => getClient()?.close()) // 关掉本 describe 内经 init 建立的单例,解绑其 window 监听

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
