// 429 退避到期时间戳(模块级):限流期间不打云端,保护入口。
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

/** 派发后失败的分类:rate_limited=429(已设退避)/ rejected=4xx 语义拒绝(重试无意义)/ network=网络错或 5xx。 */
export type SendFailReason = 'rate_limited' | 'rejected' | 'network'

export interface SendOpts {
  /** 页面卸载:优先 sendBeacon(失败回退 fetch keepalive)。 */
  useBeacon?: boolean
  /** 跳过退避检查 —— 卸载时的一次性 beacon 豁免(此刻不发就永远没机会了)。 */
  force?: boolean
  /**
   * 失败回收:批已派发但被拒(429 / 4xx / 网络错)时回调,把记录还给调用方决定
   * 重试或丢弃 —— 此前响应在异步 then 里无人接盘,429 恰好把触发它的那批吃掉。
   */
  onFail?: (records: unknown[], reason: SendFailReason) => void
}

/**
 * 发送一批记录到云端。token 放 body,只带 Content-Type(云端 CORS 仅放行 Content-Type/Accept)。
 * - 常态周期:普通 fetch(不带 keepalive —— keepalive 的 64KB 是「全部在途请求共享」的配额,
 *   多批并发时第二批起会被整批静默丢;页面活着没必要用它)。
 * - 页面卸载(useBeacon):sendBeacon,失败回退 fetch keepalive。
 * 返回是否「已派发」(退避中或无可用通道 → false,此时记录仍在调用方手里)。
 */
export function send(url: string, token: string, records: unknown[], opts: SendOpts = {}): boolean {
  if (!opts.force && inBackoff()) return false // 退避中:不打云端(调用方保留记录)
  const body = JSON.stringify({ token, records })

  if (opts.useBeacon) {
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
        keepalive: !!opts.useBeacon, // 仅卸载回退路径需要 keepalive
        credentials: 'omit',
        mode: 'cors',
      })
        .then((res) => {
          if (!res) return
          if (res.status === 429) {
            const ra = Number(res.headers?.get?.('Retry-After'))
            setBackoff(Number.isFinite(ra) ? ra : 60)
            opts.onFail?.(records, 'rate_limited')
            return
          }
          if (!res.ok) {
            // 4xx(413 体积超限 / 422 格式拒绝):重试也不会成功;5xx:服务端瞬时问题,可重试。
            opts.onFail?.(records, res.status >= 400 && res.status < 500 ? 'rejected' : 'network')
          }
        })
        .catch(() => opts.onFail?.(records, 'network'))
      return true
    }
  } catch {
    /* ignore */
  }

  return false
}
