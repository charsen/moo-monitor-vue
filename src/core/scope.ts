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
    this.tags[key] = value
  }

  setExtra(key: string, value: unknown): void {
    this.extra[key] = value
  }
}
