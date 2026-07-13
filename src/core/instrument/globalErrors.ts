import type { InstrumentCtx, Uninstall } from './types'

/**
 * 全局错误接管:window.onerror(捕获阶段,兼接资源加载错误)+ unhandledrejection。
 * 捕获阶段(true):既接 JS 运行时错误,也接资源加载错误(后者不冒泡,只能在捕获阶段拿)。
 */
export function installGlobalErrors(ctx: InstrumentCtx): Uninstall {
  const onErrorEvt = (event: Event) => {
    const target = event.target as (HTMLElement & { src?: unknown; href?: unknown }) | null
    // SVG(<image>/<use>)的 href 是 SVGAnimatedString 对象而非字符串 → 取 baseVal,
    // 否则消息变成 "[object SVGAnimatedString]",所有 SVG 资源失败被并成一条垃圾指纹。
    const rawUrl = target ? (target.src ?? target.href) : null
    const url = typeof rawUrl === 'string' ? rawUrl : ((rawUrl as { baseVal?: string } | null)?.baseVal ?? '')
    if (target && target !== (window as unknown as EventTarget) && target.tagName && url) {
      ctx.crumb({ category: 'resource', level: 'error', message: `资源加载失败: ${target.tagName} ${url}` })
      // 同 captureMessage:对象走合成栈路径,不带 SDK 内部帧;name 也更语义化(可按 ResourceError 过滤)。
      ctx.capture(
        { name: 'ResourceError', message: `Resource failed to load: ${url}` },
        { handled: false, severity: 'warning', extra: { tag: target.tagName } },
      )
      return
    }
    const e = event as ErrorEvent
    // 无原生 Error 对象(只有 message,如 ResizeObserver)时,带上事件的 filename:line:col 作定位帧。
    ctx.capture(e.error || e.message || 'Unknown error', {
      handled: false,
      severity: 'error',
      location: e.error ? undefined : { file: e.filename, line: e.lineno, column: e.colno },
    })
  }
  window.addEventListener('error', onErrorEvt, true)

  const onRejection = (event: Event) => {
    const reason = (event as PromiseRejectionEvent).reason
    // Vue Router 的导航错误会同时进 router.onError(插件已捕获并打标)和这里(未被 catch 的
    // push() 拒绝)—— 同一个 Error 捕两次 → count 翻倍。打过标的跳过。
    // __mooSeen 是与 vue/plugin.ts 的错误对象属性契约(不是模块态),原样保留。
    if (reason && typeof reason === 'object' && (reason as { __mooSeen?: boolean }).__mooSeen) return
    ctx.capture(reason ?? 'Unhandled promise rejection', { handled: false, severity: 'error' })
  }
  window.addEventListener('unhandledrejection', onRejection)

  return () => {
    window.removeEventListener('error', onErrorEvt, true)
    window.removeEventListener('unhandledrejection', onRejection)
  }
}
