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
  /** 构建插件注入的 Debug ID(云端优先按它匹配 sourcemap,与 release/文件名解耦)。 */
  debug_id?: string
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
  /** 出错位置(window.onerror 无原生 Error 对象时用来补一帧)。 */
  location?: { file?: string; line?: number; column?: number }
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
  /** 自动记录 breadcrumbs(点击 / 键盘 / 路由 / fetch),默认 true。键盘只记按键与目标元素,绝不记输入内容。 */
  autoBreadcrumbs?: boolean
  /** 自动生成会话 ID(sessionStorage,标签页生命周期),默认 true;setUser({ sessionId }) 优先。 */
  autoSession?: boolean
  /**
   * HTTP 响应错误自动捕获(经包裹的 fetch):默认 true = 状态码 ≥500 生成一条 HttpError;
   * { min: 400 } 可降阈值;false 关闭(仅留 fetch breadcrumb)。
   */
  httpErrors?: boolean | { min?: number }
  /** 噪音过滤:消息命中即丢弃(字符串包含或正则匹配)。 */
  ignoreErrors?: (string | RegExp)[]
  /**
   * 请求轨迹忽略名单(URL 包含字符串或正则命中即不记轨迹、不触发 HttpError)。
   * 默认内置常见第三方统计域名(GA/GTM/百度统计/友盟/神策/clarity 等)——
   * 它们每次 URL 都不同、折叠救不了,会把用户操作淹没在轨迹里;传 [] 可全部保留。
   */
  ignoreFetchUrls?: (string | RegExp)[]
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
  autoSession: boolean
  /** HTTP 错误捕获阈值;null = 关闭。 */
  httpErrorsMin: number | null
  ignoreErrors: (string | RegExp)[]
  ignoreFetchUrls: (string | RegExp)[]
  beforeSend?: (event: FrontendErrorRecord) => FrontendErrorRecord | null
  onError?: (err: unknown) => void
}

/** 常见第三方统计/广告域名:每次请求 URL 都不同(payload 在 query),会刷满 30 格轨迹。 */
export const DEFAULT_IGNORE_FETCH_URLS: (string | RegExp)[] = [
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'clarity.ms',
  'hm.baidu.com', 'cnzz.com', 'umeng.com', 'sensorsdata', 'growingio.com',
]

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
    // 钳到云端单请求上限 200:超出整批被 422 拒绝(且 422 属语义拒绝,重试也救不回)。
    maxBatch: Math.min(Math.max(1, o.maxBatch ?? 20), 200),
    enabled: o.enabled ?? true,
    autoCapture: o.autoCapture ?? true,
    autoBreadcrumbs: o.autoBreadcrumbs ?? true,
    autoSession: o.autoSession ?? true,
    // 阈值钳到 ≥400:min:0 之类会把所有 2xx 也捕成 HttpError,免费档配额瞬间被刷光。
    httpErrorsMin: o.httpErrors === false ? null : o.httpErrors === true || o.httpErrors == null ? 500 : Math.max(o.httpErrors.min ?? 500, 400),
    ignoreErrors: o.ignoreErrors ?? [],
    ignoreFetchUrls: o.ignoreFetchUrls ?? DEFAULT_IGNORE_FETCH_URLS,
    beforeSend: o.beforeSend,
    onError: o.onError,
  }
}
