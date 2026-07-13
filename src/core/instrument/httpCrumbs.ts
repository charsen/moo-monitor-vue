import { debugIdForFile } from '../debugIds'
import { parseStack } from '../stacktrace'
import { scrub } from '../scrub'
import type { Breadcrumb } from '../types'
import type { InstrumentCtx, Uninstall } from './types'

type AnyFetch = typeof fetch & { __mooPatched?: boolean }

/**
 * fetch / XHR 插桩(HTTP 轨迹 + HttpError 捕获)—— fetch 与 XHR 共享折叠状态(lastFetch)与
 * 落格逻辑(httpCrumb/fetchCrumb/callerFrames),必须同居一个模块;折叠经 ctx.lastCrumb() 实现。
 * 独立于 autoBreadcrumbs 门安装:HttpError 自动捕获只能由这两个补丁触发,不能被「关轨迹」连带静默关掉(P0.1)。
 * 补丁内部两个动作各自判断:记轨迹仅当 autoBreadcrumbs;捕获 HttpError 仅当 httpErrorsMin!==null(见 httpCrumb)。
 */
export function installHttpCrumbs(ctx: InstrumentCtx): Uninstall {
  const { opts, intakeUrl } = ctx
  // fetch 轨迹折叠:连续同一请求(轮询)合成一条 ×N,不让 30 格轨迹被 fetch 刷满、挤掉交互上下文。
  let lastFetch: { key: string; n: number } | null = null

  /** 请求 URL 是否在忽略名单(第三方统计等:不进轨迹、不触发 HttpError)。 */
  const isIgnoredFetchUrl = (url: string): boolean => {
    for (const p of opts.ignoreFetchUrls) {
      if (typeof p === 'string' ? url.indexOf(p) !== -1 : p.test(url)) return true
    }
    return false
  }

  /**
   * 失败请求的发起方候选帧(前 3 个):解析请求【调用时】同步留存的栈
   * (栈形如 [patched 自身, 调用方, 再上层…] → 跳过补丁取后续帧)。
   * 带多个候选是因为几乎所有项目都有 request() 封装 —— 第一帧常年指向封装文件
   * 同一行,云端按序还原并取第一个源路径不含 node_modules/ 的业务帧。
   * 绝不能在响应回调里现采 —— 微任务栈上没有业务调用方。
   */
  const callerFrames = (callStack?: string): { file?: string; line?: number; column?: number; debug_id?: string }[] => {
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

  /**
   * fetch 轨迹落格:与上一条比对,连续同一请求(同 method+url+status,典型轮询)原地折叠成
   * 「… ×N」并刷新时间;中间插入过其他轨迹(点击/路由等)则正常另起一条,保持时序不乱。
   * 失败请求(level=error)附带发起方调用帧(data.frame,含 debug_id)——
   * 云端在还原栈帧的同一遍解析里把它还原成「发起于 src/api/login.ts:42」。
   */
  const fetchCrumb = (key: string, level: Breadcrumb['level'], callStack?: string): void => {
    key = scrub(key) // 先脱敏后截断(P0.3):折叠路径直接改写 message、绕过 BreadcrumbBuffer.add,残端须在此就地脱敏
    if (key.length > 280) key = key.slice(0, 280) + '…' // data: 巨串 URL;折叠路径直接改写 message,须在此截
    const last = ctx.lastCrumb()
    if (lastFetch?.key === key && last && last.category === 'fetch') {
      lastFetch.n++
      last.message = `${key} ×${lastFetch.n}`
      last.timestamp = Date.now()
      if (level === 'error') last.level = 'error'
      return
    }
    lastFetch = { key, n: 1 }
    const crumb: Breadcrumb = { category: 'fetch', level, message: key }
    if (level === 'error') {
      const frames = callerFrames(callStack)
      if (frames.length) crumb.data = { frame: frames[0], frames }
    }
    ctx.crumb(crumb)
  }

  /**
   * HTTP 请求统一落格(fetch 与 XHR 共用):轨迹 + ≥httpErrorsMin 的 HttpError 捕获。
   * status='failed'/0 = 网络失败/中断,只记轨迹不计 HttpError(离线噪音)。
   */
  const httpCrumb = (method: string, url: string, status: number | 'failed', callStack?: string): void => {
    const failed = status === 'failed' || status === 0
    // 记轨迹仅当开 autoBreadcrumbs;HttpError 捕获独立判断(P0.1:两个动作解耦,只开 httpErrors 时不记轨迹)。
    if (opts.autoBreadcrumbs) {
      fetchCrumb(`${method} ${url} ${failed ? 'failed' : status}`, failed || (status as number) >= 400 ? 'error' : 'info', callStack)
    }
    // HTTP 响应错误自动捕获(默认 ≥500):传普通对象(非 Error)→ normalize 判定为合成栈,
    // 丢弃 SDK 内部帧。指纹按 名称+消息 聚合 —— URL 去掉 query/hash 再进消息:
    // 否则每个 query 组合一个指纹(轮询/搜索/游标场景),客户端合并失效 + 云端配额被刷爆。
    if (!failed && opts.httpErrorsMin !== null && (status as number) >= opts.httpErrorsMin) {
      ctx.capture(
        { name: 'HttpError', message: `${method} ${url.split(/[?#]/)[0]} ${status}` },
        { handled: false, severity: 'error', extra: { status, method } },
      )
    }
  }

  // ---- XHR 插桩 ----
  // axios 在浏览器默认走 XMLHttpRequest 而非 fetch —— 不包它的话,axios 应用(国内 Vue 项目主流)的
  // API 请求完全不进轨迹、HTTP 错误捕获也不生效。open 记 method/url,send 同步留存调用栈,loadend 统一落格
  // (status 0 = 网络失败/中断)。
  let origXhrOpen: typeof XMLHttpRequest.prototype.open | undefined
  let origXhrSend: typeof XMLHttpRequest.prototype.send | undefined
  let patchedXhrOpen: typeof XMLHttpRequest.prototype.open | undefined
  let patchedXhrSend: typeof XMLHttpRequest.prototype.send | undefined
  if (typeof XMLHttpRequest !== 'undefined') {
    type PatchedFn = ((...args: never[]) => unknown) & { __mooPatched?: boolean }
    const proto = XMLHttpRequest.prototype
    if (!(proto.open as PatchedFn).__mooPatched) {
      // 哨兵未命中才装(重复 init 不叠包)
      origXhrOpen = proto.open
      origXhrSend = proto.send
      const savedOpen = origXhrOpen
      const savedSend = origXhrSend
      const recordCrumbs = opts.autoBreadcrumbs // 只开 httpErrors 时不采栈(纯优化,P0.1)
      type MooXhr = XMLHttpRequest & { __moo?: { method: string; url: string; stack?: string } }

      const open = function (this: MooXhr, ...args: Parameters<XMLHttpRequest['open']>) {
        try {
          this.__moo = { method: String(args[0] || 'GET').toUpperCase(), url: String(args[1] ?? '') }
        } catch {
          /* 记录失败不影响请求本体 */
        }
        return savedOpen.apply(this, args)
      } as typeof proto.open & { __mooPatched?: boolean }
      open.__mooPatched = true

      const send = function (this: MooXhr, ...args: Parameters<XMLHttpRequest['send']>) {
        try {
          const meta = this.__moo
          if (meta && meta.url && meta.url.indexOf(intakeUrl) === -1 && !isIgnoredFetchUrl(meta.url)) {
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
                  ctx.onError(e)
                }
              },
              { once: true },
            )
          }
        } catch (e) {
          ctx.onError(e)
        }
        return savedSend.apply(this, args)
      } as typeof proto.send & { __mooPatched?: boolean }
      send.__mooPatched = true

      patchedXhrOpen = proto.open = open
      patchedXhrSend = proto.send = send
    }
  }

  // ---- fetch 插桩 ----
  // 记录 method/url/status 作 breadcrumb;排除上报自身 URL,防死循环。
  // 哨兵 __mooPatched 防重复 init() 叠加包裹(否则每层各记一条 breadcrumb)。
  let origFetch: typeof fetch | undefined
  let patchedFetch: AnyFetch | undefined
  const f = window.fetch as AnyFetch | undefined
  if (typeof f === 'function' && !f.__mooPatched) {
    origFetch = window.fetch // 原始引用(卸载时按引用还原)
    const orig = origFetch.bind(window) // 调用时绑定 window(否则部分浏览器 Illegal invocation)
    const patched = ((...args: Parameters<typeof fetch>): Promise<Response> => {
      const input = args[0]
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request)?.url
      const method = (args[1]?.method || (input as Request)?.method || 'GET').toUpperCase()
      const skip = !url || url.indexOf(intakeUrl) !== -1 || isIgnoredFetchUrl(url)
      // 调用栈须在【此刻】同步留存(仅一行栈字符串,微秒级):响应回调跑在微任务里,
      // 那时栈上只剩 SDK 自己,业务调用方早已不在 —— 在回调里采帧会把「发起于」指向 SDK。
      // 仅在开轨迹时采:callStack 唯一消费方是 fetchCrumb 的 error 帧,只开 httpErrors 时白采一次栈是纯浪费(P0.1)。
      const callStack = skip || !opts.autoBreadcrumbs ? undefined : new Error().stack
      return orig(...args).then(
        (res) => {
          if (!skip) httpCrumb(method, url, res.status, callStack)
          return res
        },
        (err) => {
          if (!skip) httpCrumb(method, url, 'failed', callStack)
          throw err
        },
      )
    }) as AnyFetch
    patched.__mooPatched = true
    patchedFetch = patched
    window.fetch = patched
  }

  return () => {
    // 仅当当前补丁仍是本模块打的才还原(别覆盖他人后续的补丁)。
    if (origFetch && (window.fetch as AnyFetch) === patchedFetch) window.fetch = origFetch
    if (typeof XMLHttpRequest !== 'undefined') {
      if (origXhrOpen && XMLHttpRequest.prototype.open === patchedXhrOpen) XMLHttpRequest.prototype.open = origXhrOpen
      if (origXhrSend && XMLHttpRequest.prototype.send === patchedXhrSend) XMLHttpRequest.prototype.send = origXhrSend
    }
    lastFetch = null
  }
}
