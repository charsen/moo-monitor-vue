import { send } from './transport'

/** 内存批量队列:满 maxBatch 或到 flushInterval 触发 flush;flush 把队列分批全部发出。 */
export class Queue {
  private buf: unknown[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private url: string,
    private token: string,
    private flushInterval = 5000,
    private maxBatch = 20,
  ) {}

  add(record: unknown): void {
    this.buf.push(record)
    if (this.buf.length >= this.maxBatch) {
      this.flush()
      return
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushInterval)
    }
  }

  /** 发出队列里全部记录(按 maxBatch 分批)。返回是否全部成功发出。 */
  flush(): boolean {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    let ok = true
    while (this.buf.length) {
      const batch = this.buf.splice(0, this.maxBatch)
      ok = send(this.url, this.token, batch) && ok
    }
    return ok
  }

  size(): number {
    return this.buf.length
  }
}
