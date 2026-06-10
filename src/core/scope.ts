import type { MooUser } from './types'

/** 随事件一起上报的上下文:当前用户 + 自定义 tags / extra。 */
export class Scope {
  user: MooUser | null = null
  tags: Record<string, string> = {}
  extra: Record<string, unknown> = {}

  setUser(u: MooUser | null): void {
    this.user = u
  }

  setTag(key: string, value: string): void {
    // 钳制:tags 随【每条】记录上报,一个超长值会把所有记录顶到截断线(挤掉 stack/轨迹)。
    this.tags[String(key).slice(0, 64)] = String(value).slice(0, 200)
  }

  setExtra(key: string, value: unknown): void {
    // 钳制:extra 随【每条】记录上报,一个大对象(如整棵 store 快照)会让所有记录超限,
    // 届时截断只能丢 payload 甚至连坐 frames/breadcrumbs。序列化超 8KB → 截断/替换占位。
    try {
      const s = JSON.stringify(value)
      if (s && s.length > 8192) {
        value = typeof value === 'string' ? value.slice(0, 8192) + '…' : '[truncated: oversized extra]'
      }
    } catch {
      value = '[unserializable extra]' // 循环引用 / BigInt 等:占位,别让一条 extra 毒翻整条记录
    }
    this.extra[String(key).slice(0, 64)] = value
  }
}
