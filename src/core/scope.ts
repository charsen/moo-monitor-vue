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
    this.extra[key] = value
  }
}
