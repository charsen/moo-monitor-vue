import { hash12 } from './hash'
import { scrub } from './scrub'
import { parseStack } from './stacktrace'
import { parseUA } from './uaParse'
import type { Breadcrumb, FrontendErrorRecord, MooUser, StackFrame } from './types'

/** 循环引用安全的 JSON 序列化(循环处标 [Circular],绝不抛错)。 */
function safeStringify(v: unknown): string {
  const seen = new WeakSet<object>()
  try {
    return (
      JSON.stringify(v, (_k, val) => {
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val)) return '[Circular]'
          seen.add(val)
        }
        return val
      }) || ''
    )
  } catch {
    return ''
  }
}

/** 把任意抛出值规整成 Error(字符串 / 对象 / 循环引用 / 任意值都兜底,保留区分度,不全压成 'Unknown error')。 */
export function toError(input: unknown): Error {
  if (input instanceof Error) return input
  if (typeof input === 'string') return new Error(input)
  if (input && typeof input === 'object') {
    // 很多库抛的是类 Error 对象:优先取其 message;否则安全序列化(循环引用也不丢区分度)。
    const maybeMsg = (input as { message?: unknown }).message
    if (typeof maybeMsg === 'string' && maybeMsg) {
      const e = new Error(maybeMsg)
      e.name = (input as { name?: string }).name || (input as object).constructor?.name || 'Error'
      return e
    }
    return new Error(safeStringify(input) || (input as object).constructor?.name || 'Object')
  }
  return new Error(String(input))
}

/**
 * 客户端指纹:类型 + 规整后的消息 + 栈顶 3 帧(file:function)。
 * 只抹平易变部分(数字 / 十六进制地址 / 长 id / 空白),【保留】引号内的属性名等区分信息
 * —— 否则 'reading "id"' 与 'reading "name"' 会被聚成一类(审查发现)。
 */
function fingerprint(name: string, message: string, frames: StackFrame[]): string {
  const top = frames
    .slice(0, 3)
    .map((f) => `${f.file || '?'}:${f.function || '?'}`)
    .join('|')
  const norm = message
    .replace(/0x[0-9a-f]+/gi, '0xN')
    .replace(/\b[0-9a-f]{8,}\b/gi, 'HEX')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  return hash12(`${name}\n${norm}\n${top}`)
}

export interface NormalizeCtx {
  env?: string
  release?: string
  project?: string
  user?: MooUser | null
  tags?: Record<string, string>
  extra?: Record<string, unknown>
  breadcrumbs?: Breadcrumb[]
  handled?: boolean
  severity?: string
  /** window.onerror 提供的出错位置(无原生 Error 对象时用来补一帧)。 */
  location?: { file?: string; line?: number; column?: number }
}

/** Error/任意值 → 上报记录(嵌套结构匹配云端 intake)。 */
export function normalize(input: unknown, ctx: NormalizeCtx): FrontendErrorRecord {
  const err = toError(input)
  const name = err.name || 'Error'
  const message = err.message || String(input)
  // 真·Error(业务 throw)栈顶即业务位置 → 保留;SDK 合成的 Error(字符串 / 对象 / onerror 仅 message)
  // 栈是 SDK 内部(toError/normalize…)无定位价值 → 丢弃,改用 onerror 的 filename:line:col 补帧。
  // 判定基于 input 是否原生 Error,与打包产物无关(不靠文件名匹配 —— 生产打包后路径已不含包名)。
  const synthetic = !(input instanceof Error)
  // 出站脱敏:堆栈帧 file / 原始 stack 里的 URL query 可能带 token,离开浏览器前打码。
  let frames = synthetic ? [] : parseStack(err.stack).map((f) => ({ ...f, file: scrub(f.file) }))
  if (!frames.length && ctx.location?.file && (ctx.location.line ?? 0) > 0) {
    frames = [{ file: scrub(ctx.location.file), line: ctx.location.line, column: ctx.location.column }]
  }
  const cleanStack = synthetic ? undefined : scrub(err.stack)

  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : undefined
  const uaInfo = ua ? parseUA(ua) : {}
  const now = new Date().toISOString()

  const payload: Record<string, unknown> = {}
  if (ctx.tags && Object.keys(ctx.tags).length) payload.tags = ctx.tags
  if (ctx.extra && Object.keys(ctx.extra).length) payload.extra = ctx.extra

  return {
    hash: fingerprint(name, message, frames),
    // first_seen = 本次发生时刻;云端仅在新建记录时采用(已存在记录保留其原始首见)。
    first_seen: now,
    last_seen: now,
    count: 1,
    error: {
      name,
      message,
      stack: cleanStack,
      handled: ctx.handled ?? true,
      severity: ctx.severity ?? 'error',
    },
    page:
      typeof location !== 'undefined'
        ? { url: scrub(location.href), referrer: typeof document !== 'undefined' ? scrub(document.referrer) || undefined : undefined }
        : {},
    client: { user_agent: ua, ...uaInfo },
    context: { env: ctx.env, release: ctx.release, project: ctx.project ?? 'web', occurred_at: now },
    frames: frames.length ? frames : undefined,
    // breadcrumb message 里常含 fetch/资源 URL(可能带 token)→ 出站脱敏。
    breadcrumbs: ctx.breadcrumbs && ctx.breadcrumbs.length
      ? ctx.breadcrumbs.map((b) => ({ ...b, message: scrub(b.message) }))
      : undefined,
    user: ctx.user
      ? {
          id: ctx.user.id != null ? String(ctx.user.id) : undefined,
          name: ctx.user.name,
          session_id: ctx.user.sessionId,
        }
      : undefined,
    payload: Object.keys(payload).length ? payload : undefined,
  }
}
