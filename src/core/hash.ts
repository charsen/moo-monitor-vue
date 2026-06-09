/**
 * 12 位十六进制指纹 —— 匹配云端去重键正则 ^[a-f0-9]{12}$。
 * 用两个 FNV-1a 32 位散列拼出 48 位(8 + 4 hex),零依赖、稳定、跨标签页一致。
 */
function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function hash12(input: string): string {
  const a = fnv1a(input).toString(16).padStart(8, '0')
  // 加盐的第二个散列,提供独立低 16 位,把指纹扩到 48 位(8 + 4 hex)。
  const b = (fnv1a('moo:' + input) & 0xffff).toString(16).padStart(4, '0')
  return (a + b).slice(0, 12).toLowerCase()
}
