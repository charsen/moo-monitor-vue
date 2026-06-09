import { describe, it, expect, vi } from 'vitest'
import { send, inBackoff } from '../src/core/transport'

const URL_ = 'https://cloud.test/api/v1/frontend-errors/intake'

describe('transport.send', () => {
  it('uses sendBeacon when useBeacon=true (页面卸载)', () => {
    const beacon = vi.fn(() => true)
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true })

    const ok = send(URL_, 'tok123', [{ hash: 'aaaaaaaaaaaa' }], true)

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
    expect(opts.keepalive).toBe(true)
    expect(opts.credentials).toBe('omit')
    const body = JSON.parse(opts.body as string)
    expect(body.token).toBe('tok123')
    expect(body.records[0].hash).toBe('bbbbbbbbbbbb')

    vi.unstubAllGlobals()
  })

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

    vi.unstubAllGlobals()
  })
})
