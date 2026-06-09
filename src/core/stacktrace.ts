import type { StackFrame } from './types'

// Chrome / Edge / Node:  "    at fn (file:line:col)"  或  "    at file:line:col"
const CHROME = /^\s*at (?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/
// Firefox / Safari:  "fn@file:line:col"  或  "@file:line:col"
const FIREFOX = /^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/

/** 把 error.stack 字符串解析成结构化帧;解析不出来就返回空数组(不抛错)。 */
export function parseStack(stack?: string, limit = 30): StackFrame[] {
  if (!stack || typeof stack !== 'string') return []
  const out: StackFrame[] = []
  for (const raw of stack.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    // 跳过首行 "TypeError: message" 之类
    if (/^[\w.]*(Error|Exception):/.test(line) && !line.includes(' at ') && !line.includes('@')) continue
    // eval 帧:格式嵌套(at fn (eval at … (url:line:col), <anonymous>:l:c)),内部 :line:col
    // 会被误当 file → 只留函数名,file 标 eval,避免脏数据污染指纹。
    if (line.includes('eval at ')) {
      const fn = /at (.+?) \(/.exec(line)
      out.push({ function: (fn?.[1] || 'eval').trim(), file: 'eval' })
      if (out.length >= limit) break
      continue
    }
    let m = CHROME.exec(line)
    if (m) {
      out.push({ function: m[1] || '?', file: m[2], line: Number(m[3]), column: Number(m[4]) })
    } else if ((m = FIREFOX.exec(line))) {
      out.push({ function: m[1] || '?', file: m[2], line: Number(m[3]), column: Number(m[4]) })
    } else if (line.startsWith('at ')) {
      // native / anonymous(无 file:line:col),如 "at fn (native)":保留函数名,不静默丢帧。
      out.push({ function: line.slice(3).replace(/\s*\(.*\)\s*$/, '').trim() || '?', file: 'native' })
    }
    if (out.length >= limit) break
  }
  return out
}
