// 框架无关入口(core)—— 可单独用于任意 JS 项目,无 Vue 依赖。
export type {
  MooOptions,
  MooUser,
  Breadcrumb,
  StackFrame,
  CaptureHint,
  FrontendErrorRecord,
} from './core/types'
export { MooClient } from './core/client'
export {
  init,
  getClient,
  captureException,
  captureMessage,
  setUser,
  setTag,
  setExtra,
  addBreadcrumb,
  flush,
  close,
} from './core/client'
