import { describe, it, expect, vi } from 'vitest'
import { send } from '../src/core/transport'

const URL_ = 'https://cloud.test/api/v1/frontend-errors/intake'

describe('transport.send', () => {
  it('uses sendBeacon (token+records in a JSON Blob)', () => {
    const beacon = vi.fn(() => true)
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true })

    const ok = send(URL_, 'tok123', [{ hash: 'aaaaaaaaaaaa' }])

    expect(ok).toBe(true)
    expect(beacon).toHaveBeenCalledOnce()
    expect(beacon.mock.calls[0][0]).toBe(URL_)
    expect(beacon.mock.calls[0][1]).toBeInstanceOf(Blob)
  })

  it('falls back to fetch keepalive with only Content-Type header', () => {
    Object.defineProperty(navigator, 'sendBeacon', { value: undefined, configurable: true })
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200 }))
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
})
