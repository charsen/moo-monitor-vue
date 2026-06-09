/**
 * 出站脱敏 —— 与云端 App\Support\SecretRedactor 同规则,在【离开浏览器前】把 URL / 文本里
 * 常见密钥打码(JWT / Bearer / token=… 等)。深度防御:敏感数据不该发出去(云端那层只是兜底)。
 */
const PATTERNS: Array<[RegExp, string]> = [
  // JWT(三段 base64url)
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '***JWT***'],
  // Bearer <token>
  [/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***'],
  // key=value / key: value(保留键名,值打码)—— 覆盖 URL query 与普通文本
  [
    /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)\b(\s*["']?\s*[:=]\s*["']?)([^\s"',&;]+)/gi,
    '$1$2***',
  ],
]

export function scrub<T extends string | undefined>(v: T): T {
  if (!v) return v
  let out: string = v
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep)
  return out as T
}
