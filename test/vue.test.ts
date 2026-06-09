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

  it('flush() sends queued events via beacon', () => {
    const beacon = vi.fn(() => true)
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true })

    const app = createApp({ render: () => h('div') })
    app.use(MooMonitor, { endpoint: 'https://cloud.test/api/v1', token: 'tok12345' })

    const client = getClient()!
    client.captureException(new Error('manual report'))
    client.flush()

    expect(beacon).toHaveBeenCalled()
  })
})
