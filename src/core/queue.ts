import { send, inBackoff, backoffRemaining, type SendFailReason } from './transport'
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
  // page.url/referrer 此前不在裁剪范围:超长 query / OAuth state 能把记录顶爆。与云端同口径 2048。
  if (out.page?.url && out.page.url.length > 2048) out.page = { ...out.page, url: out.page.url.slice(0, 2048) }
  if (out.page?.referrer && out.page.referrer.length > 2048) out.page = { ...out.page, referrer: out.page.referrer.slice(0, 2048) }
  // 二轮分级丢弃:先只丢 payload(超大 tags/extra 是最常见肇事者)—— 够了就保住
  // frames/breadcrumbs;仍超限才连坐(此前一刀全丢,一个大 extra 赔上整个栈和轨迹)。
  if (bytes(out) > MAX_RECORD_BYTES) {
    out.payload = undefined
  }
  if (bytes(out) > MAX_RECORD_BYTES) {
    out.breadcrumbs = undefined
    out.frames = undefined // frames 也可能很大(深栈),三轮再丢
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
  /** 已失败重试过一次的记录:二次失败即丢弃(计入 dropped),防无限回收循环。 */
  private retried = new WeakSet<object>()

  constructor(
    private url: string,
    private token: string,
    private flushInterval = 5000,
    private maxBatch = 20,
    private onDrop?: (n: number) => void,
  ) {}

  add(record: FrontendErrorRecord): void {
    // 同 hash 合并:累加 count;现场字段(breadcrumbs/page/user/context)整体取「最新一次发生」——
    // 云端 upsert 是 last-write-wins,若保留窗口内第一次的现场,长退避/积压后云端展示的
    // 轨迹和页面是几分钟前的旧现场,却盖着崭新的 last_seen。
    const idx = this.buf.findIndex((r) => r.hash === record.hash)
    if (idx !== -1) {
      const existing = this.buf[idx]
      const merged: FrontendErrorRecord = { ...record }
      // 「已重试」标记随合并延续:回收中的记录和新发生合并后是个新对象,
      // 不延续标记的话持续故障期间同一记录可被无限回收重试。
      if (this.retried.has(existing)) this.retried.add(merged)
      merged.count = (existing.count ?? 1) + (record.count ?? 1)
      // last_seen 取「最新」、first_seen 取「最早」—— 防乱序 / beforeSend 改写时间导致回退。
      merged.last_seen =
        record.last_seen && (!existing.last_seen || record.last_seen > existing.last_seen)
          ? record.last_seen
          : existing.last_seen
      merged.first_seen =
        record.first_seen && (!existing.first_seen || record.first_seen < existing.first_seen)
          ? record.first_seen
          : existing.first_seen
      this.buf[idx] = merged
      return
    }
    if (this.buf.length >= MAX_BUFFER) {
      // 积压上限(典型:长退避 / 长时间无网):挤掉【最旧】、收下最新 —— 旧记录的现场早已过期,
      // 当前正在发生的才要紧;丢弃计数经 onDrop 上抛(非静默)。此前是反着的:留最旧丢最新。
      this.buf.shift()
      this.dropped++
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
    // 退避中:绝不动 buf,安排「退避结束后」再 flush。
    // 例外:页面卸载(useBeacon)豁免退避 —— 安排的重试定时器会随页面一起死,
    // 不发这一枪整个缓冲就没了;一次性 beacon 不构成对云端的重试风暴。
    if (inBackoff() && !useBeacon) {
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
      if (!batch.length) return
      const recs = batch
      batch = []
      size = 0
      const dispatched = send(this.url, this.token, recs, {
        useBeacon,
        force: useBeacon, // 卸载路径豁免退避(见上)
        // 失败回收:429/网络错回缓冲重试一次,4xx 语义拒绝丢弃但计数 —— 此前这批直接人间蒸发。
        onFail: (records, reason) => this.recover(records as FrontendErrorRecord[], reason),
      })
      if (!dispatched) {
        // 没派发出去(无通道/罕见同步失败):原样收回,不算一次重试;安排下一次,别等下个 add()。
        // 注:多批「未派发」时逐批 unshift 会造成批【间】顺序反转 —— 影响可忽略(云端按 hash 聚合、
        // 时间取自记录本身 first_seen/last_seen,不依赖到达序),故此处只回插不额外排序。
        this.buf.unshift(...recs)
        this.arm(this.flushInterval)
        ok = false
      }
    }

    for (let rec of pending) {
      if (bytes(rec) > MAX_RECORD_BYTES) rec = truncateRecord(rec)
      const b = bytes(rec)
      // 两轮截断后仍超限(如 beforeSend 注入巨型字段):丢弃并计数 —— 发出去也会在
      // 卸载路径被 beacon 的 64KB 上限静默吃掉,「可感知地丢」好过「装作发了」。
      if (b > MAX_RECORD_BYTES) {
        this.dropped++
        continue
      }
      // 装不下当前批(条数或字节)→ 先发出已攒的,再开新批。
      if (batch.length && (batch.length >= this.maxBatch || size + b > MAX_BYTES)) sendBatch()
      batch.push(rec)
      size += b
    }
    sendBatch()
    return ok
  }

  /** 派发后失败的回收:可重试原因(429/网络/5xx)回缓冲一次,二次失败或语义拒绝丢弃并计数。 */
  private recover(records: FrontendErrorRecord[], reason: SendFailReason): void {
    if (reason === 'rejected') {
      this.dropped += records.length // 413/422:重试也不会成功 → 丢弃,经 onDrop 可感知
      this.arm(this.flushInterval) // 安静页面也要让 onDrop 回执在下一轮 flush 响起来,别等下个 add()

      return
    }
    let requeued = false
    for (const r of records) {
      if (this.retried.has(r) || this.buf.length >= MAX_BUFFER) {
        this.dropped++
        continue
      }
      this.retried.add(r)
      // 正序逐条 unshift 会把批【内】顺序反转([r1,r2,r3] → [r3,r2,r1])—— 同上,影响可忽略
      // (云端按 hash 聚合、时间取自记录本身),故保留正序回插、不额外倒序。
      this.buf.unshift(r) // 回收到队首,保持大致时序
      requeued = true
    }
    // 安排重发:429 时下一次 flush 会撞退避分支,自动顺延到退避结束。
    if (requeued) this.arm(this.flushInterval)
  }

  size(): number {
    return this.buf.length
  }
}
