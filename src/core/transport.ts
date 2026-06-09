/**
 * 发送一批记录到云端。优先 navigator.sendBeacon(页面卸载时仍可靠投递),
 * 不可用时退回 fetch keepalive。token 放 body,只带 Content-Type —— 云端 CORS 仅放行
 * Content-Type/Accept,加任何自定义头都会令预检失败。不读响应、失败即丢,绝不阻塞宿主。
 */
export function send(url: string, token: string, records: unknown[]): boolean {
  const body = JSON.stringify({ token, records })

  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([body], { type: 'application/json' })
      if (navigator.sendBeacon(url, blob)) return true
    }
  } catch {
    /* fall through to fetch */
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
      }).catch(() => {})
      return true
    }
  } catch {
    /* ignore */
  }

  return false
}
