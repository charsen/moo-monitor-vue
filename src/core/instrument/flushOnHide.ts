import type { InstrumentCtx, Uninstall } from './types'

/**
 * 卸载/隐藏时 flush 残余队列:visibilitychange(hidden)+ pagehide 比已废弃的 unload 更可靠;
 * 用 sendBeacon(useBeacon=true)比 fetch 更可靠地发出残余队列。
 */
export function installFlushOnHide(ctx: InstrumentCtx): Uninstall {
  const flush = () => {
    try {
      // 卸载时用 sendBeacon(useBeacon=true):比 fetch 更可靠地发出残余队列。
      ctx.flush(true)
    } catch (e) {
      ctx.onError(e)
    }
  }
  const onVisibility = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') flush()
  }
  const onPagehide = flush
  window.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onPagehide)

  return () => {
    window.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', onPagehide)
  }
}
