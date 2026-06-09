/** 短窗去重:同一指纹在 windowMs 内只放行一次,防 onerror 在循环里刷屏打爆队列 / 网络。 */
export class Deduper {
  private seen = new Map<string, number>()

  constructor(private windowMs = 4000) {}

  isDuplicate(hash: string): boolean {
    const now = Date.now()
    const last = this.seen.get(hash)
    this.seen.set(hash, now)
    if (this.seen.size > 200) {
      for (const [k, t] of this.seen) {
        if (now - t > this.windowMs) this.seen.delete(k)
      }
    }
    return last !== undefined && now - last < this.windowMs
  }
}
