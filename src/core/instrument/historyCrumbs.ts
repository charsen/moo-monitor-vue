import type { InstrumentCtx, Uninstall } from './types'

/**
 * 路由轨迹:包裹 history.pushState/replaceState(SPA 路由都走这两个)+ popstate(后退/前进),
 * 记 `from → to`(pathname+search+hash,出站时统一脱敏)。哨兵防重复包裹;卸载时按引用还原。
 */
export function installHistoryCrumbs(ctx: InstrumentCtx): Uninstall {
  const h = window.history as History | undefined
  if (!h || typeof h.pushState !== 'function') return () => {}

  // popstate(后退/前进)的 from 路径。
  // 路径含 hash:hash 路由(createWebHashHistory)的跳转只改 location.hash,
  // 不带它的话 to===from,整个 hash 模式应用一条导航轨迹都记不到。
  const cur = () => location.pathname + location.search + location.hash
  let lastPath = cur()
  const record = (from: string) => {
    const to = cur()
    if (to !== from) {
      lastPath = to
      ctx.crumb({ category: 'navigation', message: `${from} → ${to}` })
    }
  }

  type PatchedFn = History['pushState'] & { __mooPatched?: boolean }
  let origPushState: History['pushState'] | undefined
  let origReplaceState: History['replaceState'] | undefined
  let patchedPushState: History['pushState'] | undefined
  let patchedReplaceState: History['replaceState'] | undefined
  if (!(h.pushState as PatchedFn).__mooPatched) {
    origPushState = h.pushState
    origReplaceState = h.replaceState
    const wrap = (orig: History['pushState']): History['pushState'] => {
      const fn = function (this: History, ...args: Parameters<History['pushState']>) {
        const from = cur()
        const ret = orig.apply(this, args)
        record(from) // record 是闭包箭头函数,不依赖 this
        return ret
      } as PatchedFn
      fn.__mooPatched = true
      return fn
    }
    patchedPushState = h.pushState = wrap(origPushState)
    patchedReplaceState = h.replaceState = wrap(origReplaceState)
  }

  const onPopstate = () => record(lastPath)
  window.addEventListener('popstate', onPopstate)

  return () => {
    window.removeEventListener('popstate', onPopstate)
    // 仅当当前补丁仍是本模块打的才还原(别覆盖他人后续的补丁)。
    if (origPushState && window.history.pushState === patchedPushState) window.history.pushState = origPushState
    if (origReplaceState && window.history.replaceState === patchedReplaceState) window.history.replaceState = origReplaceState
  }
}
