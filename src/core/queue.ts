import { send, inBackoff, backoffRemaining } from './transport'
import type { FrontendErrorRecord } from './types'

// sendBeacon / fetch keepalive 的 body 上限约 64KB,留余量给 token 包裹 → 单批 ≤ 56KB。
const MAX_BYTES = 56_000
// 单条记录硬上限:超了就截断 stack / breadcrumbs / message,保证它能独立发出去(不被静默丢)。
const MAX_RECORD_BYTES = 48_000
// 缓冲上限:退避 / 积压时上限保护,防内存无界增长(超出丢弃,计入 dropped 并经 onDrop 上抛)。
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
 * - 单次 flush 窗口内同 hash 合并累加 count;跨窗口由云端按 (project,hash) 累计(oldCount+delta),
 *   不丢计数。刻意【不做】跨 flush 客户端去重(carry)—— 那套 TTL/定时器复杂度反复引入计数搁浅 /
 *   新错误延迟等问题,而它只省「持续高频错误少发几个请求」这点边际优化,不值当。
 * - flush 按字节分批:单批 ≤ ~56KB,避开 sendBeacon/fetch keepalive 的 64KB 静默丢弃。
 * - 退避中保留 buf 不发(不丢),退避结束后重试;缓冲到 MAX_BUFFER 才丢弃并计入 dropped。
 */
export class Queue {
  private buf: FrontendErrorRecord[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private dropped = 0

  constructor(
    private url: string,
    private token: string,
    private flushInterval = 5000,
    private maxBatch = 20,
    private onDrop?: (n: number) => void,
  ) {}

  add(record: FrontendErrorRecord): void {
    // 同 hash 合并:累加 count、取最新 last_seen、保留最早 first_seen —— 单窗口内风暴不刷网络且计数不丢。
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
    if (this.buf.length >= MAX_BUFFER) {
      // 积压上限(典型:长退避 / 长时间无网)→ 丢弃但计数,经 onDrop 让宿主可感知(非静默)。
      this.dropped++
      return
    }
    this.buf.push(record)
    if (this.buf.length >= this.maxBatch) {
      this.flush()
      return
    }
    this.arm(this.flushInterval)
  }

  /** 安排一次 flush(已有待触发定时器则不重复设);Node/SSR 下 unref,不拖住进程退出。 */
  private arm(delay: number): void {
    if (this.timer) return
    const t = setTimeout(() => this.flush(), delay)
    ;(t as unknown as { unref?: () => void }).unref?.()
    this.timer = t
  }

  /**
   * 发出队列里全部记录(按条数 + 字节双重分批)。useBeacon=true 用 sendBeacon(页面卸载)。
   * 返回是否全部已派发(退避中 → false)。
   */
  flush(useBeacon = false): boolean {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    // 退避中:绝不动 buf —— 否则记录被 splice 后随 send 一起丢失。安排「退避结束后」再 flush;
    // 期间记录留在 buf(有 MAX_BUFFER 上限保护)。
    if (inBackoff()) {
      const t = setTimeout(() => this.flush(), Math.max(1000, backoffRemaining() + 100))
      ;(t as unknown as { unref?: () => void }).unref?.()
      this.timer = t
      return false
    }
    // 积压丢弃回执:本轮真正发送前,把累计丢弃量经 onDrop 上抛(让宿主可感知,非静默)。
    if (this.dropped > 0) {
      const n = this.dropped
      this.dropped = 0
      try {
        this.onDrop?.(n)
      } catch {
        /* onDrop 不能反过来冲垮 flush */
      }
    }
    if (!this.buf.length) return true

    const pending = this.buf.splice(0)
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

  size(): number {
    return this.buf.length
  }
}
