export interface MooUser {
  id?: string | number
  name?: string
  sessionId?: string
  [k: string]: unknown
}

export interface Breadcrumb {
  type?: string
  category?: string
  message?: string
  level?: 'info' | 'warning' | 'error'
  data?: Record<string, unknown>
  timestamp?: number
}

export interface StackFrame {
  file?: string
  line?: number
  column?: number
  function?: string
}

/**
 * 上报给云端的一条前端错误记录 —— 形态与 POST /api/v1/frontend-errors/intake 的
 * record 一致(嵌套 error/page/client/context + 顶层 hash/frames/breadcrumbs/user/payload)。
 */
export interface FrontendErrorRecord {
  hash: string
  first_seen?: string
  last_seen?: string
  count?: number
  error: {
    name: string
    message: string
    stack?: string
    handled: boolean
    severity: string
  }
  page: { url?: string; referrer?: string }
  client: {
    user_agent?: string
    browser?: string
    browser_version?: string
    os?: string
    device?: string
  }
  context: { env?: string; release?: string; project?: string; occurred_at?: string }
  frames?: StackFrame[]
  breadcrumbs?: Breadcrumb[]
  user?: { id?: string; name?: string; session_id?: string }
  payload?: Record<string, unknown>
}

export interface CaptureHint {
  extra?: Record<string, unknown>
  tags?: Record<string, string>
  /** 是否「已捕获」(主动 captureException = true;全局兜底 = false)。 */
  handled?: boolean
  severity?: string
}

export interface MooOptions {
  /** 云端 API 基址,例:https://cloud.example.com/api/v1(SDK 内部拼 /frontend-errors/intake)。 */
  endpoint: string
  /** 项目推送 token(需含 frontend_errors 能力)。放 POST body —— 注意会出现在客户端 JS。 */
  token: string
  /** 环境标识,默认 'production'。 */
  env?: string
  /** 版本号(为日后 source map 还原与按版本聚合预留)。 */
  release?: string
  /** context.project 来源标识,默认 'web'。 */
  project?: string
  /** 错误采样率 0..1,默认 1(全采)。 */
  sampleRate?: number
  /** breadcrumbs 环形队列上限,默认 30。 */
  maxBreadcrumbs?: number
  /** 批量 flush 间隔(ms),默认 5000。 */
  flushInterval?: number
  /** 单批最多条数,默认 20(云端单次上限 200)。 */
  maxBatch?: number
  /** 总开关,默认 true;开发环境可关。 */
  enabled?: boolean
  /** 自动捕获全局错误 / 未处理 Promise / 资源错误,默认 true。 */
  autoCapture?: boolean
  /** 自动记录 breadcrumbs(点击 / fetch),默认 true。 */
  autoBreadcrumbs?: boolean
  /** 噪音过滤:消息命中即丢弃(字符串包含或正则匹配)。 */
  ignoreErrors?: (string | RegExp)[]
  /** 发送前钩子:返回 null 丢弃,可改写记录(脱敏 / 加字段)。 */
  beforeSend?: (event: FrontendErrorRecord) => FrontendErrorRecord | null
  /** SDK 自身错误回调(默认静默,绝不抛回宿主)。 */
  onError?: (err: unknown) => void
}

/** 归一化后的内部配置(填好默认值)。 */
export interface ResolvedOptions {
  endpoint: string
  token: string
  env: string
  release?: string
  project: string
  sampleRate: number
  maxBreadcrumbs: number
  flushInterval: number
  maxBatch: number
  enabled: boolean
  autoCapture: boolean
  autoBreadcrumbs: boolean
  ignoreErrors: (string | RegExp)[]
  beforeSend?: (event: FrontendErrorRecord) => FrontendErrorRecord | null
  onError?: (err: unknown) => void
}

export function resolveOptions(o: MooOptions): ResolvedOptions {
  return {
    endpoint: o.endpoint,
    token: o.token,
    env: o.env ?? 'production',
    release: o.release,
    project: o.project ?? 'web',
    sampleRate: o.sampleRate ?? 1,
    maxBreadcrumbs: o.maxBreadcrumbs ?? 30,
    flushInterval: o.flushInterval ?? 5000,
    maxBatch: o.maxBatch ?? 20,
    enabled: o.enabled ?? true,
    autoCapture: o.autoCapture ?? true,
    autoBreadcrumbs: o.autoBreadcrumbs ?? true,
    ignoreErrors: o.ignoreErrors ?? [],
    beforeSend: o.beforeSend,
    onError: o.onError,
  }
}
