import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-10T00:00:00Z'))
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('cross SDK safety', () => {
  it('shares the synthetic redaction corpus with native and backend SDKs', async () => {
    const { scrub } = await import('../src/core/scrub')
    const fixture = JSON.parse(readFileSync('test/fixtures/cross-sdk-redaction.json', 'utf8')) as {
      cases: { name: string; input: string; forbidden: string[]; keep: string }[]
    }
    for (const row of fixture.cases) {
      const out = scrub(row.input)
      for (const secret of row.forbidden) expect(out, row.name).not.toContain(secret)
      expect(out, row.name).toContain(row.keep)
    }
  })
  it('masks quoted and escaped credentials completely', async () => {
    const { scrub } = await import('../src/core/scrub')
    for (const input of [
      'password="first second final-secret" keep=visible',
      "db_password='first second final-secret' keep=visible",
      '{"access_token":"first \\"second\\" final-secret"} keep=visible',
    ]) {
      expect(scrub(input)).not.toContain('final-secret')
      expect(scrub(input)).toContain('keep=visible')
    }
  })

  it('uses redirect protected keepalive fetch on unload', async () => {
    const { send } = await import('../src/core/transport')
    const beacon = vi.fn(() => true)
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true })
    const fetcher = vi.fn(() => Promise.resolve({ ok: true, status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    expect(send('https://cloud.test/intake', 'fixture', [], { useBeacon: true })).toBe(true)
    expect(beacon).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledWith('https://cloud.test/intake', expect.objectContaining({
      redirect: 'error', credentials: 'omit', keepalive: true,
    }))
  })

  it.each(['7200', 'Tue, 10 Nov 2026 02:00:00 GMT'])('respects long Retry-After %s', async (header) => {
    const { send, backoffRemaining } = await import('../src/core/transport')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ status: 429, headers: { get: () => header } })))
    send('https://cloud.test/intake', 'fixture', [])
    await Promise.resolve()
    expect(backoffRemaining()).toBe(7_200_000)
  })

  it('does not shorten a longer wait when concurrent 429 responses arrive', async () => {
    const { send, backoffRemaining } = await import('../src/core/transport')
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ status: 429, headers: { get: () => '7200' } })
      .mockResolvedValueOnce({ status: 429, headers: { get: () => '60' } })
    vi.stubGlobal('fetch', fetcher)
    send('https://cloud.test/intake', 'fixture', [])
    send('https://cloud.test/intake', 'fixture', [])
    await Promise.resolve()
    expect(backoffRemaining()).toBe(7_200_000)
  })

  it('chunks long waits instead of overflowing the JavaScript timer', async () => {
    const { send } = await import('../src/core/transport')
    const { Queue } = await import('../src/core/queue')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ status: 429, headers: { get: () => '315576000' } })))
    send('https://cloud.test/intake', 'fixture', [])
    await Promise.resolve()
    const queue = new Queue('https://cloud.test/intake', 'fixture')
    const flush = vi.spyOn(queue, 'flush')
    queue.flush()
    await vi.advanceTimersByTimeAsync(1000)
    expect(flush).toHaveBeenCalledTimes(1)
    queue.close()
  })

  it('does not let a throwing delivery callback create a second failure', async () => {
    const { send } = await import('../src/core/transport')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 422 })))
    const onFail = vi.fn(() => { throw new Error('host callback failed') })
    send('https://cloud.test/intake', 'fixture', [], { onFail })
    await Promise.resolve()
    await Promise.resolve()
    expect(onFail).toHaveBeenCalledTimes(1)
  })

  it('contains onError failures and reentrant error reporting', async () => {
    const { MooClient } = await import('../src/core/client')
    const onError = vi.fn(() => {
      if (onError.mock.calls.length < 2) client.captureException(new Error('recursive'))
      throw new Error('host callback failed')
    })
    const client = new MooClient({ endpoint: 'https://cloud.test', token: 'fixture', autoCapture: false,
      autoBreadcrumbs: false, httpErrors: false, beforeSend: () => { throw new Error('rewrite failed') }, onError })
    expect(() => client.captureException(new Error('original'))).not.toThrow()
    expect(onError).toHaveBeenCalledTimes(1)
    client.close()
  })

  it('freezes and bounds metadata without invoking host getters or toJSON', async () => {
    const { normalize } = await import('../src/core/normalize')
    const privateObject = { toJSON: vi.fn(() => { throw new Error('must not call') }) }
    const nested = { password: 'metadata-secret', note: 'token=another-secret', safe: 'original' }
    const extra = { nested, privateObject }
    Object.defineProperty(extra, 'getter', { enumerable: true, get() { throw new Error('must not call') } })
    const record = normalize(new Error('fixture'), { extra, tags: { token: 'tag-secret' } })
    nested.safe = 'mutated'
    const text = JSON.stringify(record.payload)
    for (const secret of ['metadata-secret', 'another-secret', 'tag-secret', 'mutated']) expect(text).not.toContain(secret)
    expect(text).toContain('original')
    expect(privateObject.toJSON).not.toHaveBeenCalled()
    const proxy = new Proxy({}, { getPrototypeOf() { throw new Error('unsupported host object') } })
    const failed = normalize(new Error('fixture'), { extra: { proxy } })
    expect(failed.payload).toEqual({ __truncated: 'unsupported' })
  })

  it('does not restart delivery after close when an in-flight request fails', async () => {
    const { MooClient } = await import('../src/core/client')
    let reject!: (error: Error) => void
    const fetcher = vi.fn(() => new Promise<Response>((_resolve, failure) => { reject = failure }))
    vi.stubGlobal('fetch', fetcher)
    const client = new MooClient({ endpoint: 'https://cloud.test', token: 'fixture', maxBatch: 1,
      autoCapture: false, autoBreadcrumbs: false, httpErrors: false })
    client.captureException(new Error('fixture'))
    expect(fetcher).toHaveBeenCalledTimes(1)
    client.close()
    reject(new Error('offline'))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('bounds shared object graphs before serialization and byte expansion', async () => {
    const { scrubMetadata } = await import('../src/core/scrub')
    let reads = 0
    let graph: unknown = { note: 'safe' }
    for (let depth = 0; depth < 8; depth++) {
      const entries = Object.fromEntries(Array.from({ length: 16 }, (_, i) => ['k' + i, graph]))
      graph = new Proxy(entries, { getOwnPropertyDescriptor(target, key) {
        if (++reads > 512) throw new Error('unbounded traversal')
        return Reflect.getOwnPropertyDescriptor(target, key)
      } })
    }
    const out = scrubMetadata({ graph, controls: '\x00'.repeat(8192) })
    expect(reads).toBeGreaterThan(0)
    expect(reads).toBeLessThanOrEqual(512)
    expect(new TextEncoder().encode(JSON.stringify(out)).length).toBeLessThanOrEqual(8192)
  })
})
