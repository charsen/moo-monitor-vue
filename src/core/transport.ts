// 429 退避到期时间戳(模块级):限流期间不打云端,保护入口。
let backoffUntil = 0
// 队列上限只约束尚未发送的记录；慢端点下还必须限制已派发、未返回的请求。
// 与退避状态一样在模块内共享，重复 init/close 不能绕过此预算。
const MAX_IN_FLIGHT = 4
const REQUEST_TIMEOUT = 15_000
let inFlight = 0

/** 当前是否处于限流退避中(还没到可再发的时刻)。 */
export function inBackoff(): boolean {
  return Date.now() < backoffUntil
}

/** 距退避结束还有多少毫秒(用于安排退避后重试)。 */
export function backoffRemaining(): number {
  return Math.max(0, backoffUntil - Date.now())
}

function setBackoff(raw: string | null | undefined): void {
  const value = raw?.trim() ?? ''
  let delay = 60_000
  if (/^\d+$/.test(value)) {
    delay = Math.min(Number(value), 315_576_000) * 1000
  } else if (/^[A-Za-z]{3},\s/.test(value)) {
    const date = Date.parse(value)
    if (Number.isFinite(date)) delay = Math.min(315_576_000_000, Math.max(0, date - Date.now()))
  }
  // 并发请求的短等待不能覆盖另一个响应给出的长等待。
  backoffUntil = Math.max(backoffUntil, Date.now() + delay)
}

/** 派发后失败的分类:rate_limited=429(已设退避)/ rejected=4xx 语义拒绝(重试无意义)/ network=网络错或 5xx。 */
export type SendFailReason = 'rate_limited' | 'rejected' | 'network'

export interface SendOpts {
  /** 页面卸载提示，兼容原参数名；使用禁止重定向的 fetch keepalive。 */
  useBeacon?: boolean
  /** 跳过退避检查 —— 卸载时的一次性发送豁免。 */
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
 * - 页面卸载(useBeacon):fetch keepalive。sendBeacon 无法禁止 307/308 携凭据转发，故不再使用。
 * 返回是否「已派发」(退避/在途满额/无可用通道 → false,此时记录仍在调用方手里)。
 */
export function send(url: string, token: string, records: unknown[], opts: SendOpts = {}): boolean {
  if (!opts.force && inBackoff()) return false // 退避中:不打云端(调用方保留记录)
  // 卸载只豁免退避，不豁免资源上限；满额时不序列化，也不消耗队列的重试次数。
  if (inFlight >= MAX_IN_FLIGHT || typeof fetch !== 'function') return false
  const fail = (reason: SendFailReason) => {
    try { opts.onFail?.(records, reason) } catch { /* 宿主回调失败不能形成第二次失败或未处理拒绝。 */ }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let released = false
  const release = () => {
    if (released) return
    released = true
    inFlight--
    if (timer !== undefined) clearTimeout(timer)
  }
  // 在序列化/调用 fetch 前占位，避免自定义 toJSON 或 fetch 同步重入时越过上限。
  inFlight++

  try {
    const body = JSON.stringify({ token, records })
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined
    if (controller) {
      // 取消实际请求，不能只 race 一个超时 Promise 后放出名额：忽略取消的 fetch
      // 仍持有旧请求，提前放名额会重新造成无界积压。名额只在实际 settle 时释放。
      timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
      ;(timer as unknown as { unref?: () => void }).unref?.()
    }
    void fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: !!opts.useBeacon, // 仅卸载路径需要 keepalive
      credentials: 'omit',
      redirect: 'error',
      mode: 'cors',
      signal: controller?.signal,
    })
      .then((res) => {
        release()
        if (!res) return
        if (res.status === 429) {
          setBackoff(res.headers?.get?.('Retry-After'))
          fail('rate_limited')
          return
        }
        if (!res.ok) {
          // 4xx(413 体积超限 / 422 格式拒绝):重试也不会成功;5xx:服务端瞬时问题,可重试。
          fail(res.status >= 400 && res.status < 500 ? 'rejected' : 'network')
        }
      })
      .catch(() => { release(); fail('network') })
    return true
  } catch {
    release() // 序列化或 fetch 同步抛错时也要清理计时器和名额，由调用方保留原批。
  }

  return false
}
