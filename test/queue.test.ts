import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Queue } from '../src/core/queue'
import { send } from '../src/core/transport'
import type { FrontendErrorRecord } from '../src/core/types'

vi.mock('../src/core/transport', () => ({ send: vi.fn(() => true) }))
const sendMock = send as unknown as ReturnType<typeof vi.fn>

function rec(hash: string, count = 1, over: Partial<FrontendErrorRecord> = {}): FrontendErrorRecord {
  return {
    hash,
    count,
    last_seen: '2026-01-01T00:00:00.000Z',
    error: { name: 'E', message: 'm', handled: false, severity: 'error' },
    page: {},
    client: {},
    context: {},
    ...over,
  }
}

describe('Queue', () => {
  beforeEach(() => sendMock.mockClear())

  it('merges same-hash records and accumulates count (SDK-side aggregation)', () => {
    const q = new Queue('u', 't', 999_999, 20)
    q.add(rec('aaaaaaaaaaaa'))
    q.add(rec('aaaaaaaaaaaa'))
    q.add(rec('bbbbbbbbbbbb'))
    expect(q.size()).toBe(2) // 同 hash 合并成 1 条 + 另 1 条

    q.flush()
    const sent = sendMock.mock.calls[0][2] as FrontendErrorRecord[]
    const a = sent.find((r) => r.hash === 'aaaaaaaaaaaa')!
    expect(a.count).toBe(2)
  })

  it('flushes when batch hits maxBatch', () => {
    const q = new Queue('u', 't', 999_999, 2)
    q.add(rec('aaaaaaaaaaaa'))
    q.add(rec('bbbbbbbbbbbb')) // 达到 maxBatch=2 → 自动 flush
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('splits an oversized flush into multiple byte-bounded batches', () => {
    const q = new Queue('u', 't', 999_999, 1000)
    const big = 'x'.repeat(30_000) // 单条 ~30KB(未超单条上限,但两条 > 56KB 批上限)
    q.add(rec('aaaaaaaaaaaa', 1, { error: { name: 'E', message: big, handled: false, severity: 'error' } }))
    q.add(rec('bbbbbbbbbbbb', 1, { error: { name: 'E', message: big, handled: false, severity: 'error' } }))
    q.flush()
    expect(sendMock.mock.calls.length).toBe(2) // 按字节拆成两批,避开 64KB beacon 上限
  })

  it('counts real UTF-8 bytes for CJK content (not UTF-16 char length)', () => {
    const q = new Queue('u', 't', 999_999, 1000)
    // 每条 ~15000 个汉字:.length≈15000(旧逻辑两条 30000 < 56000 不拆),但 UTF-8 ≈45000 字节/条,
    // 两条 ≈90000 字节 > 56000 → 必须拆成两批。
    const cjk = '错'.repeat(15_000)
    q.add(rec('aaaaaaaaaaaa', 1, { error: { name: 'E', message: cjk, handled: false, severity: 'error' } }))
    q.add(rec('bbbbbbbbbbbb', 1, { error: { name: 'E', message: cjk, handled: false, severity: 'error' } }))
    q.flush()
    expect(sendMock.mock.calls.length).toBe(2)
  })

  it('truncates a single record that exceeds the per-record cap', () => {
    const q = new Queue('u', 't', 999_999, 1000)
    const huge = 'y'.repeat(60_000)
    q.add(rec('aaaaaaaaaaaa', 1, { error: { name: 'E', message: 'm', stack: huge, handled: false, severity: 'error' } }))
    q.flush()
    const sent = sendMock.mock.calls[0][2] as FrontendErrorRecord[]
    expect(sent[0].error.stack!.length).toBeLessThan(huge.length)
  })
})
