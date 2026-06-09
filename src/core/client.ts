import { BreadcrumbBuffer } from './breadcrumbs'
import { normalize } from './normalize'
import { Queue } from './queue'
import { isIgnored, shouldSample } from './sampling'
import { Scope } from './scope'
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
  private onVisibility?: () => void
  private onPagehide?: () => void
  private origFetch?: typeof fetch
  private patchedFetch?: AnyFetch

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
      const rec = normalize(input, {
        env: this.opts.env,
        release: this.opts.release,
        project: this.opts.project,
        user: this.scope.user,
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
    this.captureException(new Error(message), { handled: true, severity: level || 'info' })
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
      if (this.onVisibility) window.removeEventListener('visibilitychange', this.onVisibility)
      if (this.onPagehide) window.removeEventListener('pagehide', this.onPagehide)
      // 仅当当前 fetch 仍是本实例打的补丁时才还原(别覆盖他人后续的补丁)。
      if (this.origFetch && (window.fetch as AnyFetch) === this.patchedFetch) window.fetch = this.origFetch
    }
    this.installed = false
    this.opts.enabled = false // 关闭后不再捕获
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
      const target = event.target as (HTMLElement & { src?: string; href?: string }) | null
      if (target && target !== (window as unknown as EventTarget) && target.tagName && (target.src || target.href)) {
        const url = target.src || target.href
        this.addBreadcrumb({ category: 'resource', level: 'error', message: `资源加载失败: ${target.tagName} ${url}` })
        this.captureException(new Error(`Resource failed to load: ${url}`), {
          handled: false,
          severity: 'warning',
          extra: { tag: target.tagName },
        })
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
      this.captureException(reason ?? 'Unhandled promise rejection', { handled: false, severity: 'error' })
    }
    window.addEventListener('unhandledrejection', this.onRejection)
  }

  private installBreadcrumbs(): void {
    // 点击:记录可读选择器(tag#id.class),不存 DOM。className 在 SVG 上是 SVGAnimatedString,非 string → 跳过。
    this.onClick = (e: Event) => {
      const t = e.target as Element | null
      if (!t || !t.tagName) return
      const cls = typeof t.className === 'string' && t.className ? '.' + t.className.trim().split(/\s+/).join('.') : ''
      const sel = (t.tagName.toLowerCase() + (t.id ? '#' + t.id : '') + cls).slice(0, 100)
      this.addBreadcrumb({ category: 'click', message: sel })
    }
    window.addEventListener('click', this.onClick, true)

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
            if (!skip) this.addBreadcrumb({ category: 'fetch', level: res.ok ? 'info' : 'error', message: `${method} ${url} ${res.status}` })
            return res
          },
          (err) => {
            if (!skip) this.addBreadcrumb({ category: 'fetch', level: 'error', message: `${method} ${url} failed` })
            throw err
          },
        )
      }) as AnyFetch
      patched.__mooPatched = true
      this.patchedFetch = patched
      window.fetch = patched
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
