// @vitest-environment node
import { createServer } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { send } from '../src/core/transport'

const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('caps real HTTP requests, aborts stalled connections, and sends again after timeout', async () => {
  let respond = false
  let requests = 0
  let closed = 0
  let failures = 0
  let connectionsClosed!: () => void
  let attemptsFailed!: () => void
  let recovered!: () => void
  const allClosed = new Promise<void>((resolve) => { connectionsClosed = resolve })
  const allFailed = new Promise<void>((resolve) => { attemptsFailed = resolve })
  const healthyRequest = new Promise<void>((resolve) => { recovered = resolve })
  const server = createServer((request, response) => {
    requests++
    request.resume()
    if (respond) {
      response.writeHead(200)
      response.end('{}', recovered)
      return
    }
    // Leave headers unsent: real fetch must abort the socket, not merely stop awaiting it.
    response.on('close', () => { if (++closed === 4) connectionsClosed() })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('invalid local address')
  const url = `http://127.0.0.1:${address.port}/intake`
  const reasons: string[] = []
  for (let i = 0; i < 12; i++) {
    expect(send(url, 'synthetic-fixture', [], { onFail: (_records, reason) => {
      reasons.push(reason)
      if (++failures === 4) attemptsFailed()
    } })).toBe(i < 4)
  }
  await Promise.all([allClosed, allFailed])
  expect(requests).toBe(4)
  expect(closed).toBe(4)
  expect(reasons).toEqual(['network', 'network', 'network', 'network'])
  respond = true
  expect(send(url, 'synthetic-fixture', [])).toBe(true)
  await healthyRequest
  expect(requests).toBe(5)
}, 25_000)
