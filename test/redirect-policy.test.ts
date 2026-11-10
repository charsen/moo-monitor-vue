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

it('real fetch never replays a token-bearing POST after 307', async () => {
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? '')
    request.resume()
    response.writeHead(request.url === '/intake' ? 307 : 200,
      request.url === '/intake' ? { Location: '/other' } : {})
    response.end('{}')
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('invalid local address')
  const reason = await new Promise<string>((resolve, reject) => {
    if (!send(`http://127.0.0.1:${address.port}/intake`, 'synthetic-fixture', [], {
      onFail: (_records, failure) => resolve(failure),
    })) reject(new Error('not dispatched'))
  })
  expect(reason).toBe('network')
  expect(requests).toEqual(['/intake'])
})
