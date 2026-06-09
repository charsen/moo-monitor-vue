/** 采样判定:rate>=1 全采,<=0 全丢,中间按概率。 */
export function shouldSample(rate: number): boolean {
  if (rate >= 1) return true
  if (rate <= 0) return false
  return Math.random() < rate
}

/** 噪音过滤:消息命中任一规则(字符串包含 / 正则匹配)即忽略。 */
export function isIgnored(message: string, patterns: (string | RegExp)[]): boolean {
  if (!patterns.length) return false
  return patterns.some((p) =>
    typeof p === 'string' ? message.includes(p) : p instanceof RegExp ? p.test(message) : false,
  )
}
