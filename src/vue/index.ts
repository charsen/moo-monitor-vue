// Vue 适配层入口 —— re-export core 命令式 API + Vue 插件。
export type {
  MooOptions,
  MooUser,
  Breadcrumb,
  StackFrame,
  CaptureHint,
  FrontendErrorRecord,
} from '../core/types'
export {
  MooClient,
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
} from '../core/client'
export { MooMonitor, MooMonitor as default, type VuePluginOptions } from './plugin'
