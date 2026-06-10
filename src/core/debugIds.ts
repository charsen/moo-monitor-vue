import { parseStack } from './stacktrace'

/**
 * Debug ID 注册表读取:构建插件给每个 bundle 头部注入了一行 snippet,执行时以
 * `new Error().stack` 为键把该 bundle 的 debug id 存进 window._mooDebugIds ——
 * 栈串里带着这个 chunk 被浏览器【实际加载】的 URL。这里把注册表懒解析成
 * file → debugId 映射,供 normalize 给栈帧附 debug_id(云端按 ID 匹配 map,
 * 与 release / 文件名 / 部署路径解耦)。
 *
 * 注册表会随懒加载 chunk 增长:按键数变化判断是否重建缓存(O(新增 chunk) 次解析)。
 */
let cache: Record<string, string> = {}
let lastKeyCount = -1

export function debugIdForFile(file?: string): string | undefined {
  if (!file || typeof window === 'undefined') return undefined
  const reg = (window as { _mooDebugIds?: Record<string, string> })._mooDebugIds
  if (!reg) return undefined

  const keys = Object.keys(reg)
  if (keys.length !== lastKeyCount) {
    lastKeyCount = keys.length
    cache = {}
    for (const stackStr of keys) {
      try {
        const frames = parseStack(stackStr)
        // snippet 在 chunk 顶层立即执行:栈最深一帧即该 chunk 自身的加载 URL(兼容取首帧兜底)。
        const f = frames[frames.length - 1]?.file || frames[0]?.file
        if (f && f !== 'eval' && f !== 'native') cache[f] = reg[stackStr]
      } catch {
        /* 单个坏键不影响其余 */
      }
    }
  }
  return cache[file]
}

/** 仅供测试:清掉模块级缓存。 */
export function _resetDebugIdsForTests(): void {
  cache = {}
  lastKeyCount = -1
}
