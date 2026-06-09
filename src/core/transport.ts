// 429 退避到期时间戳(模块级):限流期间直接丢弃,不盲目重试,保护云端入口。
let backoffUntil = 0

/** 当前是否处于限流退避中(还没到可再发的时刻)。 */
export function inBackoff(): boolean {
  return Date.now() < backoffUntil
}

/** 距退避结束还有多少毫秒(用于安排退避后重试)。 */
export function backoffRemaining(): number {
  return Math.max(0, backoffUntil - Date.now())
}

function setBackoff(retryAfterSeconds: number): void {
  const secs = retryAfterSeconds > 0 && retryAfterSeconds < 3600 ? retryAfterSeconds : 60
  backoffUntil = Date.now() + secs * 1000
}

/**
 * 发送一批记录到云端。token 放 body,只带 Content-Type(云端 CORS 仅放行 Content-Type/Accept)。
 * - useBeacon=true(页面卸载):用 navigator.sendBeacon,可靠但读不到响应。
 * - useBeacon=false(常态周期):用 fetch,可读 429 → 解析 Retry-After 设退避;期间后续直接丢弃。
 * 返回是否「已派发」(退避中或无可用通道 → false);不读成功与否(异步),仅据响应设退避。
 */
export function send(url: string, token: string, records: unknown[], useBeacon = false): boolean {
  if (inBackoff()) return false // 退避中:丢弃,不再打云端
  const body = JSON.stringify({ token, records })

  if (useBeacon) {
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        const blob = new Blob([body], { type: 'application/json' })
        if (navigator.sendBeacon(url, blob)) return true
      }
    } catch {
      /* fall through to fetch */
    }
  }

  try {
    if (typeof fetch === 'function') {
      void fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
        credentials: 'omit',
        mode: 'cors',
      })
        .then((res) => {
          if (res && res.status === 429) {
            const ra = Number(res.headers?.get?.('Retry-After'))
            setBackoff(Number.isFinite(ra) ? ra : 60)
          }
        })
        .catch(() => {})
      return true
    }
  } catch {
    /* ignore */
  }

  return false
}
