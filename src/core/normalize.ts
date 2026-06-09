import { hash12 } from './hash'
import { parseStack } from './stacktrace'
import { parseUA } from './uaParse'
import type { Breadcrumb, FrontendErrorRecord, MooUser, StackFrame } from './types'

/** 把任意抛出值规整成 Error(字符串 / 对象 / 任意值都兜底)。 */
export function toError(input: unknown): Error {
  if (input instanceof Error) return input
  if (typeof input === 'string') return new Error(input)
  try {
    const msg = typeof input === 'object' && input !== null ? JSON.stringify(input) : String(input)
    return new Error(msg)
  } catch {
    return new Error('Unknown error')
  }
}

/** 客户端指纹:类型 + 规整后的消息 + 栈顶 3 帧(file:function),去掉易变的数字 / 引号内容。 */
function fingerprint(name: string, message: string, frames: StackFrame[]): string {
  const top = frames
    .slice(0, 3)
    .map((f) => `${f.file || '?'}:${f.function || '?'}`)
    .join('|')
  const norm = message
    .replace(/\d+/g, 'N')
    .replace(/(['"]).*?\1/g, '$1$1')
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
}

/** Error/任意值 → 上报记录(嵌套结构匹配云端 intake)。 */
export function normalize(input: unknown, ctx: NormalizeCtx): FrontendErrorRecord {
  const err = toError(input)
  const frames = parseStack(err.stack)
  const name = err.name || 'Error'
  const message = err.message || String(input)

  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : undefined
  const uaInfo = ua ? parseUA(ua) : {}
  const now = new Date().toISOString()

  const payload: Record<string, unknown> = {}
  if (ctx.tags && Object.keys(ctx.tags).length) payload.tags = ctx.tags
  if (ctx.extra && Object.keys(ctx.extra).length) payload.extra = ctx.extra

  return {
    hash: fingerprint(name, message, frames),
    last_seen: now,
    count: 1,
    error: {
      name,
      message,
      stack: err.stack,
      handled: ctx.handled ?? true,
      severity: ctx.severity ?? 'error',
    },
    page:
      typeof location !== 'undefined'
        ? { url: location.href, referrer: typeof document !== 'undefined' ? document.referrer || undefined : undefined }
        : {},
    client: { user_agent: ua, ...uaInfo },
    context: { env: ctx.env, release: ctx.release, project: ctx.project ?? 'web', occurred_at: now },
    frames: frames.length ? frames : undefined,
    breadcrumbs: ctx.breadcrumbs && ctx.breadcrumbs.length ? ctx.breadcrumbs : undefined,
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
