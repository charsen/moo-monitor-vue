import { createHash } from 'node:crypto'

/**
 * sourcemap 直传七牛的契约实现(cloud 签票据 + 浏览器/CI 直传七牛 + confirm)。
 *
 * 为什么不让 cloud 接收 .map 本体:map 动辄几 MB,multipart 直发 cloud 会把 PHP 的
 * post_max_size/upload_max_filesize、请求超时和磁盘 IO 全部压在云端;改由 cloud 只签
 * 短效七牛上传票据、文件字节从构建机直达七牛,confirm 时云端再回查对象大小与 SHA-256。
 *
 * 一个 .map 对应一组三步(与 moo-scaffold-cloud 的 /api/v1/uploads 契约一致):
 *   1) POST {endpoint}/uploads/tickets  Authorization: Bearer <sourcemaps CI token>
 *      JSON { business:'sourcemaps', release, original_name, file_size, sha256, app?, build_id?, source_mode? }
 *      → { ok, upload_id, key, region, token, expires_at }
 *   2) POST https://upload[-<region>].qiniup.com  multipart: token, key, file  (字节不经过 cloud)
 *   3) POST {endpoint}/uploads/{upload_id}/confirm  Authorization: Bearer; JSON {}
 *      → { ok:true, upload_id, business, file_name, release } (服务端未来若附 health 也会透传)
 */

/** 七牛区域 → 直传域名:z0 没有区域后缀,其余区域带 upload-<region> 前缀。 */
export const QINIU_UPLOAD_HOSTS: Record<string, string> = {
  z0: 'https://upload.qiniup.com',
  z1: 'https://upload-z1.qiniup.com',
  z2: 'https://upload-z2.qiniup.com',
  na0: 'https://upload-na0.qiniup.com',
  as0: 'https://upload-as0.qiniup.com',
}

export type SourcemapSourceMode = 'context' | 'position'

export interface SourcemapHealth {
  current_build_artifacts?: number
  missing_files?: number | null
  debug_id_coverage?: number | null
  duplicate_debug_ids?: number
  ok?: boolean
}

export interface DirectUploadTarget {
  /** 云端 API 基址,与 SDK init 的 endpoint 同值(如 https://cloud.example.com/api/v1)。 */
  endpoint: string
  /** 只含 sourcemaps 能力的 CI token。 */
  token: string
}

export interface SourcemapUploadMeta {
  release: string
  /** 多应用标识(monorepo 分桶);单应用可省略。 */
  app?: string
  /** 构建集标识(全部 map 文件名排序哈希),同一次构建的各文件必须一致。 */
  buildId?: string
  /** context=保留 sourcesContent;position=上传前已由调用方剥离源码。 */
  sourceMode?: SourcemapSourceMode
}

export interface SourcemapUploadResult {
  /** 云端登记的匹配键:产物 basename(不含 .map)。 */
  fileName: string
  release: string
  /** 服务端在 confirm 回执里附带健康摘要时透传(直传契约当前不强制返回)。 */
  health?: SourcemapHealth
  /** 七牛返回「file exists」即同一内容(key 含 sha 前缀)已传过,confirm 回查通过后按成功处理。 */
  reusedObject?: boolean
}

/** 上传失败分类:rejected 只影响单个文件(可继续);fatal 表示配置/网络/票据级问题应中止。 */
export class SourcemapUploadError extends Error {
  readonly kind: 'fatal' | 'rejected'
  readonly status?: number

  constructor(message: string, kind: 'fatal' | 'rejected' = 'fatal', status?: number) {
    super(message)
    this.name = 'SourcemapUploadError'
    this.kind = kind
    this.status = status
  }
}

/** 全部 map 文件名单排序后哈希,得到确定性的构建集标识(与历史 multipart 版一致)。 */
export function computeBuildId(fileNames: string[]): string {
  return createHash('sha256').update([...fileNames].sort().join('\n')).digest('hex').slice(0, 32)
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 解析 Retry-After:支持秒数与 HTTP 日期;解析不出时退回 2s(与旧 multipart 版同量级)。
 * 单次 429 只重试一次:CI 多文件连发撞限流的偶发场景,长时间阻塞会拖垮发布。
 */
function retryDelayMs(res: Response): number {
  const raw = res.headers.get('retry-after')
  if (raw) {
    const seconds = Number(raw)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 30) * 1000
    const at = Date.parse(raw)
    if (!Number.isNaN(at)) return Math.max(0, Math.min(at - Date.now(), 30_000))
  }
  return 2000
}

interface JsonOutcome {
  res: Response
  text: string
  body: Record<string, unknown> | null
}

/** 读取响应体并尽力解析 JSON(错误页可能不是 JSON,保留原文用于报错)。 */
async function readOutcome(res: Response): Promise<JsonOutcome> {
  const text = await res.text()
  let body: Record<string, unknown> | null = null
  try {
    const parsed: unknown = text ? JSON.parse(text) : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
  } catch {
    /* 非 JSON 响应:body 保持 null */
  }
  return { res, text, body }
}

/** 对 429 做一次重试;其余状态原样返回,由调用方决定 fatal/rejected。 */
async function fetchJson(url: string, init: RequestInit): Promise<JsonOutcome> {
  const first = await readOutcome(await fetch(url, init))
  if (first.res.status === 429) {
    await sleep(retryDelayMs(first.res))
    // init.body 是字符串或 FormData,可安全重发。
    return readOutcome(await fetch(url, init))
  }
  return first
}

/** 提取服务端错误文案:Laravel 校验错误在 errors{},框架错误在 message,业务错误在 error。 */
function errorDetail(outcome: JsonOutcome): string {
  const { body, text } = outcome
  if (body) {
    if (typeof body.error === 'string' && body.error) return body.error
    const errors = body.errors
    if (errors && typeof errors === 'object') {
      const parts = Object.entries(errors as Record<string, unknown>)
        .map(([field, value]) => `${field}: ${Array.isArray(value) ? value.join(' ') : String(value)}`)
        .filter(Boolean)
      if (parts.length) return parts.join('; ')
    }
    if (typeof body.message === 'string' && body.message) return body.message
  }
  return text ? text.slice(0, 300) : ''
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' }
}

interface Ticket {
  upload_id: string
  key: string
  region: string
  token: string
}

async function requestTicket(target: DirectUploadTarget, payload: Record<string, unknown>): Promise<Ticket> {
  const url = target.endpoint.replace(/\/+$/, '') + '/uploads/tickets'
  const outcome = await fetchJson(url, {
    method: 'POST',
    headers: { ...authHeaders(target.token), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const detail = errorDetail(outcome)
  if (!outcome.res.ok || outcome.body?.ok !== true) {
    throw new SourcemapUploadError(
      `票据申请失败 HTTP ${outcome.res.status}${detail ? ': ' + detail : ''}`,
      'fatal',
      outcome.res.status,
    )
  }
  const { upload_id, key, region, token } = outcome.body as unknown as Partial<Ticket>
  if (!upload_id || !key || !region || !token) {
    throw new SourcemapUploadError('票据响应缺少 upload_id/key/region/token', 'fatal', outcome.res.status)
  }
  return { upload_id, key, region, token }
}

/** 七牛对「目标 key 已存在」返回 614 / { error: 'file exists' };同 key 即同内容(sha 前缀),幂等重跑可复用。 */
function isQiniuFileExists(status: number, body: Record<string, unknown> | null): boolean {
  if (status === 614) return true
  const err = body?.error
  return typeof err === 'string' && /file\s*exists/i.test(err)
}

async function putQiniuObject(ticket: Ticket, bytes: Uint8Array, fileName: string): Promise<{ reusedObject: boolean }> {
  const host = QINIU_UPLOAD_HOSTS[ticket.region]
  if (!host) {
    throw new SourcemapUploadError(
      `未知七牛区域「${ticket.region}」,无法选择直传域名(可用:${Object.keys(QINIU_UPLOAD_HOSTS).join(', ')})`,
      'fatal',
    )
  }
  const form = new FormData()
  form.append('token', ticket.token)
  form.append('key', ticket.key)
  // Node 的 Buffer/Uint8Array 泛型在 DOM BlobPart 下会有 ArrayBufferLike 兼容告警;运行时字节不变。
  form.append('file', new Blob([bytes as unknown as BlobPart], { type: 'application/json' }), fileName)
  const outcome = await readOutcome(await fetch(host, { method: 'POST', body: form }))
  if (isQiniuFileExists(outcome.res.status, outcome.body)) {
    return { reusedObject: true }
  }
  if (!outcome.res.ok || outcome.body?.error) {
    const detail = errorDetail(outcome)
    throw new SourcemapUploadError(
      `七牛直传失败 HTTP ${outcome.res.status}${detail ? ': ' + detail : ''}`,
      'fatal',
      outcome.res.status,
    )
  }
  return { reusedObject: false }
}

async function confirmUpload(target: DirectUploadTarget, uploadId: string): Promise<JsonOutcome> {
  const url = target.endpoint.replace(/\/+$/, '') + `/uploads/${encodeURIComponent(uploadId)}/confirm`
  const outcome = await fetchJson(url, {
    method: 'POST',
    headers: { ...authHeaders(target.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (!outcome.res.ok || outcome.body?.ok !== true) {
    // 404=上传记录不存在/不属于本 token(配置或票据问题);422 多为对象校验不通过(单文件)。
    const kind = outcome.res.status === 422 ? 'rejected' : 'fatal'
    const detail = errorDetail(outcome)
    throw new SourcemapUploadError(
      `确认失败 HTTP ${outcome.res.status}${detail ? ': ' + detail : ''}`,
      kind,
      outcome.res.status,
    )
  }
  return outcome
}

/**
 * 上传单个 .map:签票据 → 直传七牛 → confirm。失败抛 SourcemapUploadError,调用方按 kind 处理。
 * fileName 必须是产物 basename(如 index-abc123.js.map);服务端用去掉 .map 的名字做匹配键。
 */
export async function uploadSourcemapFile(
  target: DirectUploadTarget,
  meta: SourcemapUploadMeta,
  fileName: string,
  bytes: Uint8Array,
): Promise<SourcemapUploadResult> {
  const ticket = await requestTicket(target, {
    business: 'sourcemaps',
    release: meta.release,
    original_name: fileName,
    file_size: bytes.byteLength,
    sha256: sha256Hex(bytes),
    ...(meta.app ? { app: meta.app } : {}),
    ...(meta.buildId ? { build_id: meta.buildId } : {}),
    source_mode: meta.sourceMode ?? 'context',
  })
  const put = await putQiniuObject(ticket, bytes, fileName)
  const confirmed = await confirmUpload(target, ticket.upload_id)
  const body = confirmed.body ?? {}
  return {
    fileName: typeof body.file_name === 'string' ? body.file_name : fileName.replace(/\.map$/, ''),
    release: typeof body.release === 'string' ? body.release : meta.release,
    health: body.health && typeof body.health === 'object' ? (body.health as SourcemapHealth) : undefined,
    reusedObject: put.reusedObject,
  }
}
