import type { Breadcrumb } from './types'

/** 固定长度环形队列:记录用户行为轨迹,出错时随事件上报,还原「报错前发生了什么」。 */
export class BreadcrumbBuffer {
  private items: Breadcrumb[] = []

  constructor(private max = 30) {}

  add(b: Breadcrumb): void {
    this.items.push({ timestamp: Date.now(), ...b })
    if (this.items.length > this.max) this.items.shift()
  }

  all(): Breadcrumb[] {
    return this.items.slice()
  }

  clear(): void {
    this.items = []
  }
}
