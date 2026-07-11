import { scrub } from './scrub'
import type { Breadcrumb } from './types'

/** 固定长度环形队列:记录用户行为轨迹,出错时随事件上报,还原「报错前发生了什么」。 */
export class BreadcrumbBuffer {
  private items: Breadcrumb[] = []

  constructor(private max = 30) {}

  add(b: Breadcrumb): void {
    const item = { timestamp: Date.now(), ...b }
    // 先脱敏、后截断(P0.3):导航轨迹带完整 location.hash —— OIDC 隐式流回调 #id_token=eyJ…(上千字符)
    // 若先截 300 会把三段 JWT 拦腰截成两段,出站 scrub 的 JWT 正则(需三段)不再命中 → payload 明文外泄。
    // scrub 幂等,出站 normalize 再跑一遍无害(仍是深度防御兜底)。
    if (item.message) item.message = scrub(item.message)
    // message 钳制:fetch('data:…巨串') / 超长 query 会让单条 crumb 数十 KB,
    // 把每条错误记录顶到截断线 —— 届时整组 breadcrumbs 被丢,不如此处先截。
    if (item.message && item.message.length > 300) item.message = item.message.slice(0, 300) + '…'
    this.items.push(item)
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
