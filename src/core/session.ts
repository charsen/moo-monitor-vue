/**
 * 会话标识自动化:首次取用时生成 24 位 hex,存 sessionStorage(同标签页存活,关闭即新会话)。
 * 让云端「影响用户数 / 会话数」可统计,而无需宿主手动 setUser。
 * sessionStorage 不可用(隐私模式 / 禁用存储)时退化为页面内存级(刷新即换)。
 */

const KEY = '__moo_session_id'

let memo: string | undefined

export function autoSessionId(): string | undefined {
  if (typeof window === 'undefined') return undefined
  if (memo) return memo
  try {
    const existing = window.sessionStorage.getItem(KEY)
    if (existing) return (memo = existing)
    const sid = genId()
    window.sessionStorage.setItem(KEY, sid)
    return (memo = sid)
  } catch {
    return (memo = genId())
  }
}

function genId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID().replace(/-/g, '').slice(0, 24)
    }
  } catch {
    /* 落到下面的随机回退 */
  }
  let s = ''
  for (let i = 0; i < 24; i++) s += Math.floor(Math.random() * 16).toString(16)
  return s
}

/** 仅供测试:清掉模块级缓存(sessionStorage 由测试自己清)。 */
export function _resetSessionForTests(): void {
  memo = undefined
}
