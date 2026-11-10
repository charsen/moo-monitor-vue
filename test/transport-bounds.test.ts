import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FrontendErrorRecord } from '../src/core/types'

const URL_ = 'https://cloud.test/intake'
const response = (status = 200): Response => ({
  ok: status >= 200 && status < 300, status, headers: { get: () => '0' },
}) as unknown as Response
const record = (hash: string, message = 'synthetic'): FrontendErrorRecord => ({
  hash, error: { name: 'Fixture', message, handled: true, severity: 'error' },
  page: {}, client: {}, context: {},
}) as FrontendErrorRecord

function pendingFetch(honorAbort = true) {
  const pending: { resolve: (response: Response) => void; reject: (error: Error) => void; init: RequestInit }[] = []
  const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    pending.push({ resolve, reject, init })
    if (honorAbort) init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  }))
  vi.stubGlobal('fetch', fetcher)
  return { pending, fetcher }
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('bounded delivery', () => {
  it('bounds a slow-endpoint error storm across flushes and reports queue overflow', async () => {
    const { Queue } = await import('../src/core/queue')
    const { send } = await import('../src/core/transport')
    const { fetcher, pending } = pendingFetch()
    const drops: number[] = []
    const queue = new Queue(URL_, 'fixture', 1000, 1, (n) => drops.push(n))
    for (let i = 0; i < 1000; i++) queue.add(record(String(i)))
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(queue.size()).toBe(200)
    expect(drops.reduce((sum, n) => sum + n, 0)).toBe(796)
    expect(send(URL_, 'fixture', [], { force: true, useBeacon: true })).toBe(false)
    queue.close()
    for (const request of pending) request.resolve(response())
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains undispatched byte-split batches in order and drains when capacity returns', async () => {
    const { Queue } = await import('../src/core/queue')
    const { send } = await import('../src/core/transport')
    const { pending } = pendingFetch()
    for (let i = 0; i < 4; i++) send(URL_, 'fixture', [])
    const queue = new Queue(URL_, 'fixture', 1000, 1000)
    for (let i = 0; i < 6; i++) queue.add(record(String(i), 'x'.repeat(30_000)))
    expect(queue.flush()).toBe(false)
    expect(queue.size()).toBe(6)
    for (const request of pending.slice(0, 4)) request.resolve(response())
    await Promise.resolve()
    expect(queue.flush()).toBe(false)
    expect(queue.size()).toBe(2)
    for (const request of pending.slice(4)) request.resolve(response())
    await Promise.resolve()
    // The existing timer resumes the remaining batches without another capture.
    await vi.advanceTimersByTimeAsync(1000)
    expect(queue.size()).toBe(0)
    const hashes = pending.slice(4).flatMap(({ init }) =>
      (JSON.parse(init.body as string).records as FrontendErrorRecord[]).map((r) => r.hash))
    expect(hashes).toEqual(['0', '1', '2', '3', '4', '5'])
    queue.close()
    for (const request of pending.slice(8)) request.resolve(response())
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not consume a network retry while waiting for capacity', async () => {
    const { Queue } = await import('../src/core/queue')
    const { send } = await import('../src/core/transport')
    const { pending } = pendingFetch()
    for (let i = 0; i < 4; i++) send(URL_, 'fixture', [])
    const drops = vi.fn()
    const queue = new Queue(URL_, 'fixture', 1000, 20, drops)
    queue.add(record('waiting'))
    for (let i = 0; i < 5; i++) expect(queue.flush()).toBe(false)
    for (const request of pending) request.resolve(response())
    await Promise.resolve()
    expect(queue.flush()).toBe(true)
    pending[4].reject(new Error('offline'))
    await vi.advanceTimersByTimeAsync(0)
    expect(queue.size()).toBe(1)
    expect(queue.flush()).toBe(true)
    pending[5].resolve(response())
    await Promise.resolve()
    expect(queue.size()).toBe(0)
    expect(drops).not.toHaveBeenCalled()
    queue.close()
  })

  it('aborts after 15 seconds, reports one failure, and frees capacity', async () => {
    const { send } = await import('../src/core/transport')
    const { pending } = pendingFetch()
    const onFail = vi.fn()
    for (let i = 0; i < 4; i++) send(URL_, 'fixture', [{ hash: i }], { onFail })
    await vi.advanceTimersByTimeAsync(14_999)
    expect(onFail).not.toHaveBeenCalled()
    expect(pending.every(({ init }) => init.signal?.aborted === false)).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(pending.every(({ init }) => init.signal?.aborted)).toBe(true)
    expect(onFail).toHaveBeenCalledTimes(4)
    expect(onFail).toHaveBeenCalledWith([{ hash: 0 }], 'network')
    expect(vi.getTimerCount()).toBe(0)
    expect(send(URL_, 'fixture', [])).toBe(true)
    pending[4].resolve(response())
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the cap when a custom fetch ignores abort rather than creating more pending work', async () => {
    const { send } = await import('../src/core/transport')
    const { pending, fetcher } = pendingFetch(false)
    for (let i = 0; i < 4; i++) send(URL_, 'fixture', [])
    await vi.advanceTimersByTimeAsync(20_000)
    expect(pending.every(({ init }) => init.signal?.aborted)).toBe(true)
    expect(send(URL_, 'fixture', [])).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(4)
    for (const request of pending) request.resolve(response())
    await Promise.resolve()
    expect(send(URL_, 'fixture', [])).toBe(true)
    pending[4].resolve(response())
    await Promise.resolve()
  })

  it('keeps bounded sending usable without AbortController', async () => {
    const { send } = await import('../src/core/transport')
    vi.stubGlobal('AbortController', undefined)
    const { pending } = pendingFetch()
    for (let i = 0; i < 4; i++) expect(send(URL_, 'fixture', [])).toBe(true)
    expect(send(URL_, 'fixture', [])).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    for (const request of pending) request.resolve(response())
    await Promise.resolve()
    expect(send(URL_, 'fixture', [])).toBe(true)
    pending[4].resolve(response())
    await Promise.resolve()
  })

  it.each([200, 429, 422, 503, 'network'] as const)('clears request timers and capacity after %s', async (status) => {
    const { send } = await import('../src/core/transport')
    const { pending } = pendingFetch()
    for (let i = 0; i < 4; i++) send(URL_, 'fixture', [])
    expect(send(URL_, 'fixture', [])).toBe(false)
    for (const request of pending) {
      if (status === 'network') request.reject(new Error('offline'))
      else request.resolve(response(status))
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(send(URL_, 'fixture', [])).toBe(true)
    pending[4].resolve(response())
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases capacity on synchronous serialization or fetch errors', async () => {
    const { send } = await import('../src/core/transport')
    const cycle: unknown[] = []
    cycle.push(cycle)
    for (let i = 0; i < 10; i++) expect(send(URL_, 'fixture', cycle)).toBe(false)
    vi.stubGlobal('fetch', () => { throw new Error('unavailable') })
    for (let i = 0; i < 10; i++) expect(send(URL_, 'fixture', [])).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    const { pending } = pendingFetch()
    expect(send(URL_, 'fixture', [])).toBe(true)
    pending[0].resolve(response())
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not restart a closed client after its final keepalive send times out', async () => {
    const { MooClient } = await import('../src/core/client')
    const { pending, fetcher } = pendingFetch()
    const onError = vi.fn()
    const client = new MooClient({ endpoint: URL_, token: 'fixture', autoCapture: false,
      autoBreadcrumbs: false, httpErrors: false, onError })
    client.captureException(new Error('synthetic'))
    client.close()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(pending[0].init.keepalive).toBe(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(pending[0].init.signal?.aborted).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
