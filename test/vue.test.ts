import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp, h } from 'vue'
import { MooMonitor } from '../src/vue/plugin'
import { getClient } from '../src/core/client'

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
