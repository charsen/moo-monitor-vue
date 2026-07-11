import { BreadcrumbBuffer } from './breadcrumbs'
import { installDomCrumbs } from './instrument/domCrumbs'
import { installFlushOnHide } from './instrument/flushOnHide'
import { installGlobalErrors } from './instrument/globalErrors'
import { installHistoryCrumbs } from './instrument/historyCrumbs'
import { installHttpCrumbs } from './instrument/httpCrumbs'
import type { InstrumentCtx, Uninstall } from './instrument/types'
import { normalize } from './normalize'
import { Queue } from './queue'
import { isIgnored, shouldSample } from './sampling'
import { Scope } from './scope'
import { autoSessionId } from './session'
import { resolveOptions, type Breadcrumb, type CaptureHint, type FrontendErrorRecord, type MooOptions, type MooUser, type ResolvedOptions } from './types'

export class MooClient {
  private opts: ResolvedOptions
  private intakeUrl: string
  private queue: Queue
  private crumbs: BreadcrumbBuffer
  private scope = new Scope()
  private installed = false
  // 各插桩模块的卸载函数 —— close() 逐个调用还原(补丁按引用条件还原、哨兵检查等语义内聚在各模块闭包里)。
  private uninstallers: Uninstall[] = []

  constructor(options: MooOptions) {
    this.opts = resolveOptions(options)
    this.intakeUrl = this.opts.endpoint.replace(/\/+$/, '') + '/frontend-errors/intake'
    this.queue = new Queue(this.intakeUrl, this.opts.token, this.opts.flushInterval, this.opts.maxBatch, (n) =>
      this.opts.onError?.(new Error(`moo-monitor-vue: dropped ${n} records (buffer full / backoff)`)),
    )
    this.crumbs = new BreadcrumbBuffer(this.opts.maxBreadcrumbs)
    if (this.opts.enabled && typeof window !== 'undefined') this.install()
  }

  // ---- 命令式 API ----

  captureException(input: unknown, hint: CaptureHint = {}): void {
    try {
      if (!this.opts.enabled) return
      // 会话自动化:setUser 给的 sessionId 优先;否则补上自动生成的(autoSession 关闭则不补)。
      let user = this.scope.user
      if (this.opts.autoSession) {
        const sid = user?.sessionId ?? autoSessionId()
        if (sid) user = { ...(user || {}), sessionId: sid }
      }
      const rec = normalize(input, {
        env: this.opts.env,
        release: this.opts.release,
        project: this.opts.project,
        user,
        tags: { ...this.scope.tags, ...(hint.tags || {}) },
        extra: { ...this.scope.extra, ...(hint.extra || {}) },
        breadcrumbs: this.crumbs.all(),
        handled: hint.handled ?? true,
        severity: hint.severity,
        location: hint.location,
      })
      if (isIgnored(rec.error.message, this.opts.ignoreErrors)) return
      if (!shouldSample(this.opts.sampleRate)) return
      // 计数由队列在单次 flush 窗口内按 hash 合并、跨窗口由云端累计(不丢计数,也不做易出 bug 的客户端跨窗去重)。
      let out: FrontendErrorRecord | null = rec
      if (this.opts.beforeSend) out = this.opts.beforeSend(rec)
      if (!out) return
      this.queue.add(out)
    } catch (e) {
      this.opts.onError?.(e)
    }
  }

  captureMessage(message: string, level: Breadcrumb['level'] = 'info'): void {
    // 传普通对象而非 new Error:SDK 里 new 出来的 Error 栈全是监控代码自己(captureMessage→
    // captureException→bundle 内部帧),会被当成出错位置且污染指纹 —— 对象走合成栈路径,帧被丢弃。
    this.captureException({ name: 'Message', message }, { handled: true, severity: level || 'info' })
  }

  setUser(user: MooUser | null): void {
    this.scope.setUser(user)
  }

  setTag(key: string, value: string): void {
    this.scope.setTag(key, value)
  }

  setExtra(key: string, value: unknown): void {
    this.scope.setExtra(key, value)
  }

  addBreadcrumb(b: Breadcrumb): void {
    this.crumbs.add(b)
  }

  flush(useBeacon = false): boolean {
    return this.queue.flush(useBeacon)
  }

  /** 解绑全部监听器 + 还原 fetch + flush 残余队列 —— 重复 init / 微前端卸载时调用,防泄漏与重复上报。 */
  close(): boolean {
    const ok = this.flush(true)
    // 各插桩模块逐个还原(单个失败不阻断其余);补丁按引用条件还原的逻辑内聚在各模块 uninstall 里。
    for (const u of this.uninstallers.splice(0)) {
      try {
        u()
      } catch (e) {
        this.opts.onError?.(e)
      }
    }
    this.installed = false
    this.opts.enabled = false // 关闭后不再捕获;也是「补丁无法还原时靠 captureException 门禁兜底」的安全网
    return ok
  }

  // ---- 自动接管 ----

  /** 供插桩模块回调总装的窄接口(朴素对象,方法各转发到对应命令式 API)。 */
  private makeCtx(): InstrumentCtx {
    return {
      opts: this.opts,
      intakeUrl: this.intakeUrl,
      crumb: (b) => this.addBreadcrumb(b),
      lastCrumb: () => this.crumbs.last(),
      capture: (input, hint) => this.captureException(input, hint),
      flush: (useBeacon) => this.flush(useBeacon),
      onError: (e) => this.opts.onError?.(e),
    }
  }

  /** 装一个插桩模块:各自 try/catch(与 close 对称,一处抛错不连坐其余),收下其 Uninstall。 */
  private tryInstall(fn: () => Uninstall | undefined): void {
    try {
      const u = fn()
      if (u) this.uninstallers.push(u)
    } catch (e) {
      this.opts.onError?.(e)
    }
  }

  private install(): void {
    if (this.installed) return
    this.installed = true
    const ctx = this.makeCtx()
    // releaseCheck 先跑(见 releaseCheck 顺序调整):此刻本实例必未打 fetch 补丁,同步取 window.fetch
    // 并 bind(window) 发出自检请求 —— 不再需要跨模块拿 origFetch(与旧 `origFetch ?? window.fetch` 分支等价)。
    this.tryInstall(() => {
      this.checkSourcemapRelease()
      return undefined
    })
    if (this.opts.autoCapture) this.tryInstall(() => installGlobalErrors(ctx))
    if (this.opts.autoBreadcrumbs) {
      this.tryInstall(() => installDomCrumbs(ctx))
      this.tryInstall(() => installHistoryCrumbs(ctx))
    }
    // fetch/XHR 补丁独立于 autoBreadcrumbs 门:HttpError 自动捕获只能靠这两个补丁触发,
    // 不能被「关轨迹」连带静默关掉(P0.1)。补丁内部记轨迹与捕获 HttpError 两个动作各自判断。
    if (this.opts.autoBreadcrumbs || this.opts.httpErrorsMin !== null) this.tryInstall(() => installHttpCrumbs(ctx))
    this.tryInstall(() => installFlushOnHide(ctx))
  }

  private checkSourcemapRelease(): void {
    const check = this.opts.releaseCheck
    if (!check || !this.opts.release || typeof window === 'undefined' || typeof window.fetch !== 'function') return
    if (check.sampleRate <= 0 || Math.random() > check.sampleRate) return

    const url = this.opts.endpoint.replace(/\/+$/, '') + '/sourcemaps/check'
    const body = JSON.stringify({ token: this.opts.token, release: this.opts.release, app: check.app })
    // install() 里本函数【先于】httpCrumbs 调用:此刻本实例必未打补丁,直接取 window.fetch 即可
    // (与旧 `origFetch ?? window.fetch` 分支取到同一引用,零行为变化)。
    const fetcher = window.fetch.bind(window)
    void fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      credentials: 'omit',
      mode: 'cors',
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as
          | { vip?: boolean; health?: { artifact_count?: number; debug_id_coverage?: number | null; duplicate_debug_ids?: number; restorable_rate?: number | null } }
          | null
        if (!res.ok || !data?.health) {
          throw new Error(`release check failed: HTTP ${res.status}`)
        }
        const h = data.health
        if (data.vip && (h.artifact_count ?? 0) === 0) {
          this.opts.onError?.(new Error(`moo-monitor-vue: release ${this.opts.release} has no sourcemap artifacts`))
        } else if ((h.duplicate_debug_ids ?? 0) > 0) {
          this.opts.onError?.(new Error(`moo-monitor-vue: release ${this.opts.release} has duplicate sourcemap debug ids`))
        } else if (h.debug_id_coverage != null && h.debug_id_coverage < 1) {
          this.opts.onError?.(new Error(`moo-monitor-vue: release ${this.opts.release} sourcemap debug id coverage is ${Math.round(h.debug_id_coverage * 100)}%`))
        }
      })
      .catch((e) => this.opts.onError?.(e))
  }
}

// ---- 模块级单例:供非组件代码直接调用 ----

let _client: MooClient | null = null

export function init(options: MooOptions): MooClient {
  // 重复 init(微前端 / HMR):先关掉旧实例,解绑其监听器 + 还原 fetch,防泄漏与重复上报。
  _client?.close()
  _client = new MooClient(options)
  return _client
}

export function getClient(): MooClient | null {
  return _client
}

export const captureException = (e: unknown, hint?: CaptureHint): void => _client?.captureException(e, hint)
export const captureMessage = (m: string, level?: Breadcrumb['level']): void => _client?.captureMessage(m, level)
export const setUser = (u: MooUser | null): void => _client?.setUser(u)
export const setTag = (k: string, v: string): void => _client?.setTag(k, v)
export const setExtra = (k: string, v: unknown): void => _client?.setExtra(k, v)
export const addBreadcrumb = (b: Breadcrumb): void => _client?.addBreadcrumb(b)
export const flush = (useBeacon?: boolean): boolean => _client?.flush(useBeacon) ?? false
export const close = (): boolean => _client?.close() ?? false
