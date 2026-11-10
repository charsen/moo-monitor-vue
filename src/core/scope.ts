import type { MooUser } from './types'
import { scrubMetadata } from './scrub'

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
    if (typeof key !== 'string' || typeof value !== 'string') return
    const clean = scrubMetadata({ [key]: value }) as Record<string, unknown>
    for (const [safeKey, safeValue] of Object.entries(clean)) {
      if (typeof safeValue === 'string') this.tags[safeKey] = safeValue.slice(0, 200).replace(/[\uD800-\uDBFF]$/, '')
    }
  }

  setExtra(key: string, value: unknown): void {
    // 先冻结/脱敏再限制容量，不能先 stringify 宿主对象或切断 JWT 后才清洗。
    if (typeof key !== 'string') return
    const clean = scrubMetadata({ [key]: value })
    if (clean && typeof clean === 'object') {
      for (const [safeKey, safeValue] of Object.entries(clean)) {
        Object.defineProperty(this.extra, safeKey, { value: safeValue, writable: true, enumerable: true, configurable: true })
      }
    }
  }
}
