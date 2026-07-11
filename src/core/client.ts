import { BreadcrumbBuffer } from './breadcrumbs'
import { debugIdForFile } from './debugIds'
import { installDomCrumbs } from './instrument/domCrumbs'
import { installGlobalErrors } from './instrument/globalErrors'
import type { InstrumentCtx, Uninstall } from './instrument/types'
import { normalize } from './normalize'
import { parseStack } from './stacktrace'
import { scrub } from './scrub'
import { Queue } from './queue'
import { isIgnored, shouldSample } from './sampling'
import { Scope } from './scope'
import { autoSessionId } from './session'
import { resolveOptions, type Breadcrumb, type CaptureHint, type FrontendErrorRecord, type MooOptions, type MooUser, type ResolvedOptions } from './types'

type AnyFetch = typeof fetch & { __mooPatched?: boolean }

export class MooClient {
  private opts: ResolvedOptions
  private intakeUrl: string
  private queue: Queue
  private crumbs: BreadcrumbBuffer
  private scope = new Scope()
  private installed = false
  // 各插桩模块的卸载函数 —— close() 逐个调用还原(补丁按引用条件还原、哨兵检查等语义内聚在各模块闭包里)。
  private uninstallers: Uninstall[] = []
  // 监听器 / 补丁引用 —— 供 close() 解绑还原(否则重复 init / 微前端会泄漏监听器 + 重复上报)。
  private onPopstate?: EventListener
  private onVisibility?: () => void
  private onPagehide?: () => void
  private origFetch?: typeof fetch
  private patchedFetch?: AnyFetch
  private origXhrOpen?: typeof XMLHttpRequest.prototype.open
  private origXhrSend?: typeof XMLHttpRequest.prototype.send
  private patchedXhrOpen?: typeof XMLHttpRequest.prototype.open
  private patchedXhrSend?: typeof XMLHttpRequest.prototype.send
  private origPushState?: History['pushState']
  private origReplaceState?: History['replaceState']
  private patchedPushState?: History['pushState']
  private patchedReplaceState?: History['replaceState']
  /** fetch 轨迹折叠:连续同一请求(轮询)合成一条 ×N,不让 30 格轨迹被 fetch 刷满、挤掉交互上下文。 */
  private lastFetch: { key: string; n: number } | null = null
  /** popstate(后退/前进)的 from 路径。 */
  private lastPath = ''

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
    if (typeof window !== 'undefined') {
      if (this.onPopstate) window.removeEventListener('popstate', this.onPopstate)
      if (this.onVisibility) window.removeEventListener('visibilitychange', this.onVisibility)
      if (this.onPagehide) window.removeEventListener('pagehide', this.onPagehide)
      // 仅当当前补丁仍是本实例打的才还原(别覆盖他人后续的补丁)。
      if (this.origFetch && (window.fetch as AnyFetch) === this.patchedFetch) window.fetch = this.origFetch
      if (this.origPushState && window.history.pushState === this.patchedPushState) window.history.pushState = this.origPushState
      if (this.origReplaceState && window.history.replaceState === this.patchedReplaceState) window.history.replaceState = this.origReplaceState
      if (typeof XMLHttpRequest !== 'undefined') {
        if (this.origXhrOpen && XMLHttpRequest.prototype.open === this.patchedXhrOpen) XMLHttpRequest.prototype.open = this.origXhrOpen
        if (this.origXhrSend && XMLHttpRequest.prototype.send === this.patchedXhrSend) XMLHttpRequest.prototype.send = this.origXhrSend
      }
    }
    this.installed = false
    this.opts.enabled = false // 关闭后不再捕获
    this.lastFetch = null
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
    if (this.opts.autoCapture) this.tryInstall(() => installGlobalErrors(ctx))
    if (this.opts.autoBreadcrumbs) this.tryInstall(() => installDomCrumbs(ctx))
    try {
      if (this.opts.autoBreadcrumbs) this.installNavigationBreadcrumbs()
      // fetch/XHR 补丁独立于 autoBreadcrumbs 门:HttpError 自动捕获只能靠这两个补丁触发,
      // 不能被「关轨迹」连带静默关掉(P0.1)。补丁内部记轨迹与捕获 HttpError 两个动作各自判断。
      if (this.opts.autoBreadcrumbs || this.opts.httpErrorsMin !== null) this.installHttpInstrumentation()
      this.installFlushOnHide()
      this.checkSourcemapRelease()
    } catch (e) {
      this.opts.onError?.(e)
    }
  }

  /**
   * fetch / XHR 插桩(HTTP 轨迹 + HttpError 捕获)—— 独立于 autoBreadcrumbs 门安装:
   * HttpError 自动捕获只能由这两个补丁触发,不能被「关轨迹」连带静默关掉(P0.1)。
   * 补丁内部两个动作各自判断:记轨迹仅当 autoBreadcrumbs;捕获 HttpError 仅当 httpErrorsMin!==null(见 httpCrumb)。
   */
  private installHttpInstrumentation(): void {
    this.installXhrBreadcrumbs()

    // fetch:记录 method/url/status 作 breadcrumb;排除上报自身 URL,防死循环。
    // 哨兵 __mooPatched 防重复 init() 叠加包裹(否则每层各记一条 breadcrumb)。
    const f = window.fetch as AnyFetch | undefined
    if (typeof f === 'function' && !f.__mooPatched) {
      this.origFetch = window.fetch // 原始引用(close 时按引用还原)
      const orig = this.origFetch.bind(window) // 调用时绑定 window(否则部分浏览器 Illegal invocation)
      const self = this.intakeUrl
      const patched = ((...args: Parameters<typeof fetch>): Promise<Response> => {
        const input = args[0]
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request)?.url
        const method = (args[1]?.method || (input as Request)?.method || 'GET').toUpperCase()
        const skip = !url || url.indexOf(self) !== -1 || this.isIgnoredFetchUrl(url)
        // 调用栈须在【此刻】同步留存(仅一行栈字符串,微秒级):响应回调跑在微任务里,
        // 那时栈上只剩 SDK 自己,业务调用方早已不在 —— 在回调里采帧会把「发起于」指向 SDK。
        // 仅在开轨迹时采:callStack 唯一消费方是 fetchCrumb 的 error 帧,只开 httpErrors 时白采一次栈是纯浪费(P0.1)。
        const callStack = skip || !this.opts.autoBreadcrumbs ? undefined : new Error().stack
        return orig(...args).then(
          (res) => {
            if (!skip) this.httpCrumb(method, url, res.status, callStack)
            return res
          },
          (err) => {
            if (!skip) this.httpCrumb(method, url, 'failed', callStack)
            throw err
          },
        )
      }) as AnyFetch
      patched.__mooPatched = true
      this.patchedFetch = patched
      window.fetch = patched
    }
  }

  /**
   * 路由轨迹:包裹 history.pushState/replaceState(SPA 路由都走这两个)+ popstate(后退/前进),
   * 记 `from → to`(pathname+search,出站时统一脱敏)。哨兵防重复包裹;close() 按引用还原。
   */
  private installNavigationBreadcrumbs(): void {
    const h = window.history as History | undefined
    if (!h || typeof h.pushState !== 'function') return

    // 路径含 hash:hash 路由(createWebHashHistory)的跳转只改 location.hash,
    // 不带它的话 to===from,整个 hash 模式应用一条导航轨迹都记不到。
    const cur = () => location.pathname + location.search + location.hash
    this.lastPath = cur()
    const record = (from: string) => {
      const to = cur()
      if (to !== from) {
        this.lastPath = to
        this.addBreadcrumb({ category: 'navigation', message: `${from} → ${to}` })
      }
    }

    type PatchedFn = History['pushState'] & { __mooPatched?: boolean }
    if (!(h.pushState as PatchedFn).__mooPatched) {
      this.origPushState = h.pushState
      this.origReplaceState = h.replaceState
      const wrap = (orig: History['pushState']): History['pushState'] => {
        const fn = function (this: History, ...args: Parameters<History['pushState']>) {
          const from = cur()
          const ret = orig.apply(this, args)
          record(from) // record 是箭头函数,this 已绑定客户端实例
          return ret
        } as PatchedFn
        fn.__mooPatched = true
        return fn
      }
      this.patchedPushState = h.pushState = wrap(this.origPushState)
      this.patchedReplaceState = h.replaceState = wrap(this.origReplaceState)
    }

    this.onPopstate = () => record(this.lastPath)
    window.addEventListener('popstate', this.onPopstate)
  }

  /**
   * XHR 插桩:axios 在浏览器默认走 XMLHttpRequest 而非 fetch —— 不包它的话,
   * axios 应用(国内 Vue 项目主流)的 API 请求完全不进轨迹、HTTP 错误捕获也不生效。
   * open 记 method/url,send 同步留存调用栈,loadend 统一落格(status 0 = 网络失败/中断)。
   */
  private installXhrBreadcrumbs(): void {
    if (typeof XMLHttpRequest === 'undefined') return
    type PatchedFn = ((...args: never[]) => unknown) & { __mooPatched?: boolean }
    const proto = XMLHttpRequest.prototype
    if ((proto.open as PatchedFn).__mooPatched) return // 哨兵:重复 init 不叠包

    this.origXhrOpen = proto.open
    this.origXhrSend = proto.send
    const origXhrOpen = this.origXhrOpen
    const origXhrSend = this.origXhrSend
    const intake = this.intakeUrl
    const recordCrumbs = this.opts.autoBreadcrumbs // 只开 httpErrors 时不采栈(纯优化,P0.1)
    const isIgnoredFetchUrl = (url: string) => this.isIgnoredFetchUrl(url)
    const httpCrumb = (method: string, url: string, status: number | 'failed', callStack?: string) =>
      this.httpCrumb(method, url, status, callStack)
    const onError = (e: unknown) => this.opts.onError?.(e)
    type MooXhr = XMLHttpRequest & { __moo?: { method: string; url: string; stack?: string } }

    const open = function (this: MooXhr, ...args: Parameters<XMLHttpRequest['open']>) {
      try {
        this.__moo = { method: String(args[0] || 'GET').toUpperCase(), url: String(args[1] ?? '') }
      } catch {
        /* 记录失败不影响请求本体 */
      }
      return origXhrOpen.apply(this, args)
    } as typeof proto.open & { __mooPatched?: boolean }
    open.__mooPatched = true

    const send = function (this: MooXhr, ...args: Parameters<XMLHttpRequest['send']>) {
      try {
        const meta = this.__moo
        if (meta && meta.url && meta.url.indexOf(intake) === -1 && !isIgnoredFetchUrl(meta.url)) {
          // 仅开轨迹时同步留存栈(loadend 回调里业务调用方已不在栈上);只开 httpErrors 时不采,纯优化(P0.1)。
          meta.stack = recordCrumbs ? new Error().stack : undefined
          // once:同一 XHR 实例合法复用(open→send→loadend→open→send)时,不加 once 则第二次
          // loadend 会连同旧监听一起触发 —— 旧监听闭包持第一次请求的 meta、用第二次的 status 落格,
          // 一次请求两条 crumb、HttpError 双计且 URL 张冠李戴(P0.2)。
          this.addEventListener(
            'loadend',
            () => {
              try {
                httpCrumb(meta.method, meta.url, this.status || 'failed', meta.stack)
              } catch (e) {
                onError(e)
              }
            },
            { once: true },
          )
        }
      } catch (e) {
        onError(e)
      }
      return origXhrSend.apply(this, args)
    } as typeof proto.send & { __mooPatched?: boolean }
    send.__mooPatched = true

    this.patchedXhrOpen = proto.open = open
    this.patchedXhrSend = proto.send = send
  }

  /** 请求 URL 是否在忽略名单(第三方统计等:不进轨迹、不触发 HttpError)。 */
  private isIgnoredFetchUrl(url: string): boolean {
    for (const p of this.opts.ignoreFetchUrls) {
      if (typeof p === 'string' ? url.indexOf(p) !== -1 : p.test(url)) return true
    }
    return false
  }

  /**
   * HTTP 请求统一落格(fetch 与 XHR 共用):轨迹 + ≥httpErrorsMin 的 HttpError 捕获。
   * status='failed'/0 = 网络失败/中断,只记轨迹不计 HttpError(离线噪音)。
   */
  private httpCrumb(method: string, url: string, status: number | 'failed', callStack?: string): void {
    const failed = status === 'failed' || status === 0
    // 记轨迹仅当开 autoBreadcrumbs;HttpError 捕获独立判断(P0.1:两个动作解耦,只开 httpErrors 时不记轨迹)。
    if (this.opts.autoBreadcrumbs) {
      this.fetchCrumb(`${method} ${url} ${failed ? 'failed' : status}`, failed || (status as number) >= 400 ? 'error' : 'info', callStack)
    }
    // HTTP 响应错误自动捕获(默认 ≥500):传普通对象(非 Error)→ normalize 判定为合成栈,
    // 丢弃 SDK 内部帧。指纹按 名称+消息 聚合 —— URL 去掉 query/hash 再进消息:
    // 否则每个 query 组合一个指纹(轮询/搜索/游标场景),客户端合并失效 + 云端配额被刷爆。
    if (!failed && this.opts.httpErrorsMin !== null && (status as number) >= this.opts.httpErrorsMin) {
      this.captureException(
        { name: 'HttpError', message: `${method} ${url.split(/[?#]/)[0]} ${status}` },
        { handled: false, severity: 'error', extra: { status, method } },
      )
    }
  }

  /**
   * fetch 轨迹落格:与上一条比对,连续同一请求(同 method+url+status,典型轮询)原地折叠成
   * 「… ×N」并刷新时间;中间插入过其他轨迹(点击/路由等)则正常另起一条,保持时序不乱。
   * 失败请求(level=error)附带发起方调用帧(data.frame,含 debug_id)——
   * 云端在还原栈帧的同一遍解析里把它还原成「发起于 src/api/login.ts:42」。
   */
  private fetchCrumb(key: string, level: Breadcrumb['level'], callStack?: string): void {
    key = scrub(key) // 先脱敏后截断(P0.3):折叠路径直接改写 message、绕过 BreadcrumbBuffer.add,残端须在此就地脱敏
    if (key.length > 280) key = key.slice(0, 280) + '…' // data: 巨串 URL;折叠路径直接改写 message,须在此截
    const last = this.crumbs.last()
    if (this.lastFetch?.key === key && last && last.category === 'fetch') {
      this.lastFetch.n++
      last.message = `${key} ×${this.lastFetch.n}`
      last.timestamp = Date.now()
      if (level === 'error') last.level = 'error'
      return
    }
    this.lastFetch = { key, n: 1 }
    const crumb: Breadcrumb = { category: 'fetch', level, message: key }
    if (level === 'error') {
      const frames = this.callerFrames(callStack)
      if (frames.length) crumb.data = { frame: frames[0], frames }
    }
    this.addBreadcrumb(crumb)
  }

  /**
   * 失败请求的发起方候选帧(前 3 个):解析请求【调用时】同步留存的栈
   * (栈形如 [patched 自身, 调用方, 再上层…] → 跳过补丁取后续帧)。
   * 带多个候选是因为几乎所有项目都有 request() 封装 —— 第一帧常年指向封装文件
   * 同一行,云端按序还原并取第一个源路径不含 node_modules/ 的业务帧。
   * 绝不能在响应回调里现采 —— 微任务栈上没有业务调用方。
   */
  private callerFrames(callStack?: string): { file?: string; line?: number; column?: number; debug_id?: string }[] {
    try {
      if (!callStack) return []
      const out: { file?: string; line?: number; column?: number; debug_id?: string }[] = []
      for (const f of parseStack(callStack).slice(1, 4)) {
        if (!f?.file || f.file === 'native' || f.file === 'eval') continue
        out.push({ file: scrub(f.file), line: f.line, column: f.column, debug_id: debugIdForFile(f.file) })
      }
      return out
    } catch {
      return []
    }
  }

  private installFlushOnHide(): void {
    const flush = () => {
      try {
        // 卸载时用 sendBeacon(useBeacon=true):比 fetch 更可靠地发出残余队列。
        this.flush(true)
      } catch (e) {
        this.opts.onError?.(e)
      }
    }
    // visibilitychange(hidden)+ pagehide 比已废弃的 unload 更可靠;beacon 在此仍能发出残余队列。
    this.onVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') flush()
    }
    this.onPagehide = flush
    window.addEventListener('visibilitychange', this.onVisibility)
    window.addEventListener('pagehide', this.onPagehide)
  }

  private checkSourcemapRelease(): void {
    const check = this.opts.releaseCheck
    if (!check || !this.opts.release || typeof window === 'undefined' || typeof window.fetch !== 'function') return
    if (check.sampleRate <= 0 || Math.random() > check.sampleRate) return

    const url = this.opts.endpoint.replace(/\/+$/, '') + '/sourcemaps/check'
    const body = JSON.stringify({ token: this.opts.token, release: this.opts.release, app: check.app })
    const fetcher = (this.origFetch ?? window.fetch).bind(window)
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
