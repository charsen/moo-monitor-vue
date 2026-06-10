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

  /** 最近一条(返回内部对象引用,供 fetch 轨迹「×N」原地折叠等场景)。 */
  last(): Breadcrumb | undefined {
    return this.items[this.items.length - 1]
  }

  clear(): void {
    this.items = []
  }
}
