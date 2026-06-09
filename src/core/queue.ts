import { send, inBackoff, backoffRemaining } from './transport'
import type { FrontendErrorRecord } from './types'

// sendBeacon / fetch keepalive 的 body 上限约 64KB,留余量给 token 包裹 → 单批 ≤ 56KB。
const MAX_BYTES = 56_000
// 单条记录硬上限:超了就截断 stack / breadcrumbs / message,保证它能独立发出去(不被静默丢)。
const MAX_RECORD_BYTES = 48_000
// 缓冲上限:退避 / 积压时上限保护,防内存无界增长(超出丢弃)。
const MAX_BUFFER = 200

// 真实 UTF-8 字节数(不能用 .length —— UTF-16 码元数;中文每字 .length=1 但 UTF-8 占 3 字节,
// 否则中文负载会把批体积严重低估,实际超 64KB → sendBeacon/keepalive 静默丢)。
const ENC = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null

function bytes(v: unknown): number {
  try {
    const s = JSON.stringify(v)
    return ENC ? ENC.encode(s).length : s.length * 3 // 无 TextEncoder 时按最坏 3x 估
  } catch {
    return MAX_RECORD_BYTES + 1
  }
}

/** 单条记录过大时按优先级裁剪(先砍最占体积的 stack / breadcrumbs / frames,再砍 message),
 *  直到落到 MAX_RECORD_BYTES 以内,保证它能独立发出去(不被静默丢)。 */
function truncateRecord(r: FrontendErrorRecord): FrontendErrorRecord {
  const out: FrontendErrorRecord = { ...r, error: { ...r.error } }
  if (out.error.stack && out.error.stack.length > 4000) out.error.stack = out.error.stack.slice(0, 4000) + '…<truncated>'
  if (out.breadcrumbs && out.breadcrumbs.length > 10) out.breadcrumbs = out.breadcrumbs.slice(-10)
  if (out.frames && out.frames.length > 20) out.frames = out.frames.slice(0, 20)
  if (bytes(out) > MAX_RECORD_BYTES) {
    out.breadcrumbs = undefined
    out.payload = undefined
    out.frames = undefined // frames 也可能很大(深栈),二轮直接丢
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
  // 跨 flush 去重:近期已发过的 hash(→ 发送时刻)+ TTL 内累积的记录,削减高频错误的请求数。
  private sentAt = new Map<string, number>()
  private carry = new Map<string, FrontendErrorRecord>()
  private dedupeTtl = 30_000

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
      // last_seen 取「最新」、first_seen 取「最早」—— 防乱序 / beforeSend 改写时间导致回退。
      if (record.last_seen && (!existing.last_seen || record.last_seen > existing.last_seen)) {
        existing.last_seen = record.last_seen
      }
      if (record.first_seen && (!existing.first_seen || record.first_seen < existing.first_seen)) {
        existing.first_seen = record.first_seen
      }
      return
    }
    // 跨 flush 去重:近期(dedupeTtl 内)已发过同 hash → 累积到 carry,不立即入队;到期由 flush 补发一次。
    const last = this.sentAt.get(record.hash)
    if (last !== undefined && Date.now() - last < this.dedupeTtl) {
      const c = this.carry.get(record.hash)
      if (c) {
        c.count = (c.count ?? 1) + (record.count ?? 1)
        if (record.last_seen && (!c.last_seen || record.last_seen > c.last_seen)) c.last_seen = record.last_seen
      } else {
        this.carry.set(record.hash, record)
      }
      // carry 也要 arm 定时器:否则错误停止 + 无后续 add/flush 时,carry 累积的计数永远发不出去。
      this.arm(this.dedupeTtl)
      return
    }
    if (this.buf.length >= MAX_BUFFER) return // 积压上限保护(如长退避期):丢弃,防内存无界。
    this.buf.push(record)
    if (this.buf.length >= this.maxBatch) {
      this.flush()
      return
    }
    this.arm(this.flushInterval)
  }

  /** 安排一次 flush(已有待触发定时器则不重复设)。 */
  private arm(delay: number): void {
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), delay)
    }
  }

  /**
   * 发出队列里全部记录(按条数 + 字节双重分批)。useBeacon=true 用 sendBeacon(页面卸载)。
   * 返回是否全部已派发(退避中/无通道 → false)。
   */
  flush(useBeacon = false): boolean {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    // 退避中:绝不动 buf/carry/sentAt —— 否则记录被 splice 后随 send 一起丢失,且 sentAt 被污染会压制
    // 同类后续错误。改为安排「退避结束后」再 flush 一次,期间记录留在 buf(有 MAX_BUFFER 上限保护)。
    if (inBackoff()) {
      this.timer = setTimeout(() => this.flush(), Math.max(1000, backoffRemaining() + 100))
      return false
    }
    const now = Date.now()
    // 释放到期的 carry(高频错误在 TTL 内累积,到期补发一次)。
    for (const [hash, rec] of this.carry) {
      if (now - (this.sentAt.get(hash) ?? 0) >= this.dedupeTtl) {
        this.buf.push(rec)
        this.carry.delete(hash)
      }
    }
    if (!this.buf.length) return true

    const pending = this.buf.splice(0)
    for (const r of pending) this.sentAt.set(r.hash, now)
    this.prune(now)

    let ok = true
    let batch: FrontendErrorRecord[] = []
    let size = 0

    const sendBatch = () => {
      if (batch.length) {
        ok = send(this.url, this.token, batch, useBeacon) && ok
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

  /** sentAt 表防无界增长:超阈值时清掉已过 TTL 且无 carry 的条目。 */
  private prune(now: number): void {
    if (this.sentAt.size < 500) return
    for (const [h, t] of this.sentAt) {
      if (now - t >= this.dedupeTtl && !this.carry.has(h)) this.sentAt.delete(h)
    }
  }

  size(): number {
    return this.buf.length
  }
}
