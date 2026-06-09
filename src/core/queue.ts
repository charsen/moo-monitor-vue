import { send } from './transport'
import type { FrontendErrorRecord } from './types'

// sendBeacon / fetch keepalive 的 body 上限约 64KB,留余量给 token 包裹 → 单批 ≤ 56KB。
const MAX_BYTES = 56_000
// 单条记录硬上限:超了就截断 stack / breadcrumbs / message,保证它能独立发出去(不被静默丢)。
const MAX_RECORD_BYTES = 48_000

function bytes(v: unknown): number {
  try {
    return JSON.stringify(v).length
  } catch {
    return MAX_RECORD_BYTES + 1
  }
}

/** 单条记录过大时按优先级裁剪(先砍最占体积的 stack / breadcrumbs / frames,再砍 message)。 */
function truncateRecord(r: FrontendErrorRecord): FrontendErrorRecord {
  const out: FrontendErrorRecord = { ...r, error: { ...r.error } }
  if (out.error.stack && out.error.stack.length > 4000) out.error.stack = out.error.stack.slice(0, 4000) + '…<truncated>'
  if (out.breadcrumbs && out.breadcrumbs.length > 10) out.breadcrumbs = out.breadcrumbs.slice(-10)
  if (out.frames && out.frames.length > 20) out.frames = out.frames.slice(0, 20)
  if (bytes(out) > MAX_RECORD_BYTES) {
    out.breadcrumbs = undefined
    out.payload = undefined
    if (out.error.stack && out.error.stack.length > 1500) out.error.stack = out.error.stack.slice(0, 1500) + '…<truncated>'
    if (out.error.message.length > 2000) out.error.message = out.error.message.slice(0, 2000) + '…'
  }
  return out
}

/**
 * 内存批量队列:满 maxBatch 或到 flushInterval 触发 flush。
 * - 按 hash 合并:同指纹在队列里累加 count(SDK 端聚合,真正成为云端累计的来源,不再恒发 1)。
 * - flush 按字节分批:单批 ≤ ~56KB,避开 sendBeacon/fetch keepalive 的 64KB 静默丢弃。
 */
export class Queue {
  private buf: FrontendErrorRecord[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private url: string,
    private token: string,
    private flushInterval = 5000,
    private maxBatch = 20,
  ) {}

  add(record: FrontendErrorRecord): void {
    // 同 hash 合并:累加 count、取最新 last_seen、保留最早 first_seen —— 风暴下不刷网络且计数不丢。
    const existing = this.buf.find((r) => r.hash === record.hash)
    if (existing) {
      existing.count = (existing.count ?? 1) + (record.count ?? 1)
      existing.last_seen = record.last_seen ?? existing.last_seen
      if (record.first_seen && (!existing.first_seen || record.first_seen < existing.first_seen)) {
        existing.first_seen = record.first_seen
      }
      return
    }
    this.buf.push(record)
    if (this.buf.length >= this.maxBatch) {
      this.flush()
      return
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushInterval)
    }
  }

  /** 发出队列里全部记录(按条数 + 字节双重分批)。返回是否全部成功发出。 */
  flush(): boolean {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.buf.length) return true

    const pending = this.buf.splice(0)
    let ok = true
    let batch: FrontendErrorRecord[] = []
    let size = 0

    const sendBatch = () => {
      if (batch.length) {
        ok = send(this.url, this.token, batch) && ok
        batch = []
        size = 0
      }
    }

    for (let rec of pending) {
      if (bytes(rec) > MAX_RECORD_BYTES) rec = truncateRecord(rec)
      const b = bytes(rec)
      // 装不下当前批(条数或字节)→ 先发出已攒的,再开新批。
      if (batch.length && (batch.length >= this.maxBatch || size + b > MAX_BYTES)) sendBatch()
      batch.push(rec)
      size += b
    }
    sendBatch()
    return ok
  }

  size(): number {
    return this.buf.length
  }
}
