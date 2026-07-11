import type { Breadcrumb, CaptureHint, ResolvedOptions } from '../types'

/** 插桩模块的卸载函数:close() 时逐个调用还原(解绑监听 / 按引用还原补丁 / 释放闭包态)。 */
export type Uninstall = () => void

/**
 * 插桩模块与总装(MooClient)之间的窄接口 —— 模块只依赖它、绝不反向 import client。
 * ctx 是个朴素对象(不引入事件总线 / DI 容器 / 基类继承)。
 */
export interface InstrumentCtx {
  opts: ResolvedOptions
  intakeUrl: string
  /** → client.addBreadcrumb(入环前 scrub + 截断)。 */
  crumb(b: Breadcrumb): void
  /** 最近一条轨迹的【活引用】—— httpCrumbs 的「×N」原地折叠必需(见 breadcrumbs.ts 的 last() 刻意返回内部引用)。 */
  lastCrumb(): Breadcrumb | undefined
  /** → client.captureException。 */
  capture(input: unknown, hint?: CaptureHint): void
  /** → client.flush(flushOnHide 用,useBeacon=true)。 */
  flush(useBeacon: boolean): boolean
  /** → opts.onError(上报 SDK 自身错误,默认静默、绝不抛回宿主)。 */
  onError(e: unknown): void
}
