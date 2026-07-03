import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MooClient } from '../src/core/client'

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

    new MooClient({ ...OPTS, release: 'v1-aabbccdd', autoBreadcrumbs: false, releaseCheck: true, onError })
    expect(fetchMock).toHaveBeenCalledWith('https://c.test/api/v1/sourcemaps/check', expect.objectContaining({ method: 'POST' }))
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('has no sourcemap artifacts') })))
  })
})
