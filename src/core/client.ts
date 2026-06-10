import { BreadcrumbBuffer } from './breadcrumbs'
import { describeElement, isEditable } from './dom'
import { normalize } from './normalize'
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
  // 监听器 / 补丁引用 —— 供 close() 解绑还原(否则重复 init / 微前端会泄漏监听器 + 重复上报)。
  private onErrorEvt?: EventListener
  private onRejection?: EventListener
  private onClick?: EventListener
  private onKeydown?: EventListener
  private onPopstate?: EventListener
  private onVisibility?: () => void
  private onPagehide?: () => void
  private origFetch?: typeof fetch
  private patchedFetch?: AnyFetch
  private origPushState?: History['pushState']
  private origReplaceState?: History['replaceState']
  private patchedPushState?: History['pushState']
  private patchedReplaceState?: History['replaceState']
  /** 打字聚合:同一元素的连续输入只记一条「输入 →」crumb(换元素 / 按 Enter/Escape 后重新计)。 */
  private lastInputEl: Element | null = null
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
    if (typeof window !== 'undefined') {
      if (this.onErrorEvt) window.removeEventListener('error', this.onErrorEvt, true)
      if (this.onRejection) window.removeEventListener('unhandledrejection', this.onRejection)
      if (this.onClick) window.removeEventListener('click', this.onClick, true)
      if (this.onKeydown) window.removeEventListener('keydown', this.onKeydown, true)
      if (this.onPopstate) window.removeEventListener('popstate', this.onPopstate)
      if (this.onVisibility) window.removeEventListener('visibilitychange', this.onVisibility)
      if (this.onPagehide) window.removeEventListener('pagehide', this.onPagehide)
      // 仅当当前补丁仍是本实例打的才还原(别覆盖他人后续的补丁)。
      if (this.origFetch && (window.fetch as AnyFetch) === this.patchedFetch) window.fetch = this.origFetch
      if (this.origPushState && window.history.pushState === this.patchedPushState) window.history.pushState = this.origPushState
      if (this.origReplaceState && window.history.replaceState === this.patchedReplaceState) window.history.replaceState = this.origReplaceState
    }
    this.installed = false
    this.opts.enabled = false // 关闭后不再捕获
    this.lastInputEl = null // 释放 DOM 引用(微前端卸载后不滞留已脱离的节点)
    this.lastFetch = null
    return ok
  }

  // ---- 自动接管 ----

  private install(): void {
    if (this.installed) return
    this.installed = true
    try {
      if (this.opts.autoCapture) this.installGlobalHandlers()
      if (this.opts.autoBreadcrumbs) this.installBreadcrumbs()
      this.installFlushOnHide()
    } catch (e) {
      this.opts.onError?.(e)
    }
  }

  private installGlobalHandlers(): void {
    // 捕获阶段(true):既接 JS 运行时错误,也接资源加载错误(后者不冒泡,只能在捕获阶段拿)。
    this.onErrorEvt = (event: Event) => {
      const target = event.target as (HTMLElement & { src?: unknown; href?: unknown }) | null
      // SVG(<image>/<use>)的 href 是 SVGAnimatedString 对象而非字符串 → 取 baseVal,
      // 否则消息变成 "[object SVGAnimatedString]",所有 SVG 资源失败被并成一条垃圾指纹。
      const rawUrl = target ? (target.src ?? target.href) : null
      const url = typeof rawUrl === 'string' ? rawUrl : ((rawUrl as { baseVal?: string } | null)?.baseVal ?? '')
      if (target && target !== (window as unknown as EventTarget) && target.tagName && url) {
        this.addBreadcrumb({ category: 'resource', level: 'error', message: `资源加载失败: ${target.tagName} ${url}` })
        // 同 captureMessage:对象走合成栈路径,不带 SDK 内部帧;name 也更语义化(可按 ResourceError 过滤)。
        this.captureException(
          { name: 'ResourceError', message: `Resource failed to load: ${url}` },
          { handled: false, severity: 'warning', extra: { tag: target.tagName } },
        )
        return
      }
      const e = event as ErrorEvent
      // 无原生 Error 对象(只有 message,如 ResizeObserver)时,带上事件的 filename:line:col 作定位帧。
      this.captureException(e.error || e.message || 'Unknown error', {
        handled: false,
        severity: 'error',
        location: e.error ? undefined : { file: e.filename, line: e.lineno, column: e.colno },
      })
    }
    window.addEventListener('error', this.onErrorEvt, true)

    this.onRejection = (event: Event) => {
      const reason = (event as PromiseRejectionEvent).reason
      // Vue Router 的导航错误会同时进 router.onError(插件已捕获并打标)和这里(未被 catch 的
      // push() 拒绝)—— 同一个 Error 捕两次 → count 翻倍。打过标的跳过。
      if (reason && typeof reason === 'object' && (reason as { __mooSeen?: boolean }).__mooSeen) return
      this.captureException(reason ?? 'Unhandled promise rejection', { handled: false, severity: 'error' })
    }
    window.addEventListener('unhandledrejection', this.onRejection)
  }

  private installBreadcrumbs(): void {
    // 点击:document 级捕获,解析「用户操作的元素」—— 就近交互祖先(点中 button 里的 span 也归到 button)
    // + 可读选择器 + aria/文本提示(见 dom.ts;输入控件绝不取值)。不存 DOM 引用。
    // 整体 try/catch:轨迹手柄抛错会冒到 window.onerror 被 SDK 自己捕获成「宿主错误」(自噪音)。
    this.onClick = (e: Event) => {
      try {
        const t = e.target as Element | null
        if (!t || !t.tagName) return
        this.lastInputEl = null // 点了别处,下一段输入重新记
        this.addBreadcrumb({ category: 'click', message: describeElement(t) })
      } catch (err) {
        this.opts.onError?.(err)
      }
    }
    window.addEventListener('click', this.onClick, true)

    // 键盘:只记两类、绝不记输入内容 ——
    //   ① Enter / Escape(提交、取消的关键节点);
    //   ② 可编辑元素上的「开始输入」(同一元素的连续打字聚合成一条,只记目标不记值)。
    this.onKeydown = (e: Event) => {
      try {
        const ke = e as KeyboardEvent
        // 扩展/测试工具会用普通 Event 派发 keydown(无 .key)→ 兜成空串,绝不抛。
        const key = typeof ke.key === 'string' ? ke.key : ''
        const t = ke.target as Element | null
        if (key === 'Enter' || key === 'Escape') {
          this.lastInputEl = null
          this.addBreadcrumb({ category: 'key', message: `${key} → ${describeElement(t)}` })
          return
        }
        if (ke.ctrlKey || ke.metaKey || ke.altKey) return // 快捷键不算输入
        if (key.length === 1 && t && t.tagName && isEditable(t)) {
          if (this.lastInputEl === t) return
          this.lastInputEl = t
          this.addBreadcrumb({ category: 'input', message: `输入 → ${describeElement(t)}` })
        }
      } catch (err) {
        this.opts.onError?.(err)
      }
    }
    window.addEventListener('keydown', this.onKeydown, true)

    this.installNavigationBreadcrumbs()

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
        const skip = !url || url.indexOf(self) !== -1
        return orig(...args).then(
          (res) => {
            if (!skip) {
              this.fetchCrumb(`${method} ${url} ${res.status}`, res.ok ? 'info' : 'error')
              // HTTP 响应错误自动捕获(默认 ≥500):传普通对象(非 Error)→ normalize 判定为合成栈,
              // 丢弃 SDK 内部帧。指纹按 名称+消息 聚合 —— URL 去掉 query/hash 再进消息:
              // 否则每个 query 组合一个指纹(轮询/搜索/游标场景),客户端合并失效 + 云端配额被刷爆。
              if (this.opts.httpErrorsMin !== null && res.status >= this.opts.httpErrorsMin) {
                this.captureException(
                  { name: 'HttpError', message: `${method} ${url.split(/[?#]/)[0]} ${res.status}` },
                  { handled: false, severity: 'error', extra: { status: res.status, method } },
                )
              }
            }
            return res
          },
          (err) => {
            if (!skip) this.fetchCrumb(`${method} ${url} failed`, 'error')
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

    this.lastPath = location.pathname + location.search
    const record = (from: string) => {
      const to = location.pathname + location.search
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
          const from = location.pathname + location.search
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
   * fetch 轨迹落格:与上一条比对,连续同一请求(同 method+url+status,典型轮询)原地折叠成
   * 「… ×N」并刷新时间;中间插入过其他轨迹(点击/路由等)则正常另起一条,保持时序不乱。
   */
  private fetchCrumb(key: string, level: Breadcrumb['level']): void {
    const last = this.crumbs.last()
    if (this.lastFetch?.key === key && last && last.category === 'fetch') {
      this.lastFetch.n++
      last.message = `${key} ×${this.lastFetch.n}`
      last.timestamp = Date.now()
      if (level === 'error') last.level = 'error'
      return
    }
    this.lastFetch = { key, n: 1 }
    this.addBreadcrumb({ category: 'fetch', level, message: key })
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
