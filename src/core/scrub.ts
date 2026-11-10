/**
 * 出站脱敏 —— 在【离开浏览器前】把 URL / 文本里
 * 常见密钥打码(JWT / Bearer / token=… 等)。深度防御:敏感数据不该发出去(云端那层只是兜底)。
 */
const PATTERNS: Array<[RegExp, string]> = [
  // JWT(三段 base64url)
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '***JWT***'],
  // Bearer <token>
  [/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***'],
]

// 带前缀的键及完整引号值（含转义引号）；与移动端及后端共用假数据回归。
const KEY_VALUE = /\b([\w.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|jwt|authorization|cookie)[\w.-]*\s*["']?\s*[:=]\s*)("(?:[^"\\\r\n]|\\.)*(?:"|$)|'(?:[^'\\\r\n]|\\.)*(?:'|$)|[^\s"',&;]+)/gi

export function scrub<T extends string | undefined>(v: T): T {
  if (!v) return v
  if (v.length > 65_536) return '[truncated]' as T
  let out: string = v
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep)
  out = out.replace(KEY_VALUE, (_match, prefix: string, secret: string) => {
    const quote = secret[0]
    if (quote === '"' || quote === "'") return prefix + quote + '***' + (secret.length > 1 && secret.endsWith(quote) ? quote : '')
    return prefix + '***'
  })
  return out as T
}

/** 有界、不可变的诊断快照；不调用宿主 getter、toJSON 或未知对象的字符串转换。 */
export function scrubMetadata(input: unknown): unknown {
  let nodes = 128
  let characters = 8192
  const secretKey = /password|passwd|pwd|secret|token|api[_-]?key|authorization|cookie|credential/i
  const text = (value: string, limit = 1024): string => {
    const clean = scrub(value)
    const cap = Math.max(0, Math.min(characters, limit))
    // 不在代理对中间切断，否则 JSON 会带孤立 surrogate，服务端可能整批拒收。
    const out = clean.length <= cap ? clean : clean.slice(0, cap).replace(/[\uD800-\uDBFF]$/, '')
    characters -= out.length
    return out
  }
  const visit = (value: unknown, depth: number): unknown => {
    if (--nodes < 0 || depth > 4 || characters <= 0) return '[truncated]'
    if (value == null || typeof value === 'boolean') return value
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (typeof value === 'string') return text(value)
    if (typeof value !== 'object') return '[unsupported]'
    if (Array.isArray(value)) {
      const out: unknown[] = []
      for (let i = 0; i < Math.min(16, value.length) && nodes > 0 && characters > 0; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i))
        out.push(descriptor && 'value' in descriptor ? visit(descriptor.value, depth + 1) : '[unsupported]')
      }
      return out
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return '[unsupported]'
    const out: Record<string, unknown> = Object.create(null)
    let entries = 0
    for (const key in value) {
      if (entries++ >= 16 || nodes <= 0 || characters <= 0) break
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable) continue
      const safeKey = text(key, 64)
      out[safeKey] = key.length > 65_536 ? '[truncated]' : secretKey.test(key) ? '***'
        : 'value' in descriptor ? visit(descriptor.value, depth + 1) : '[unsupported]'
    }
    return out
  }
  try {
    const out = visit(input, 0)
    const encoded = JSON.stringify(out)
    const bytes = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(encoded).length : encoded.length * 3
    return bytes <= 8192 ? out : { __truncated: 'oversized' }
  } catch {
    return { __truncated: 'unsupported' }
  }
}
