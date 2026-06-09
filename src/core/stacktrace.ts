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
    let m = CHROME.exec(line)
    if (m) {
      out.push({ function: m[1] || '?', file: m[2], line: Number(m[3]), column: Number(m[4]) })
    } else if ((m = FIREFOX.exec(line))) {
      out.push({ function: m[1] || '?', file: m[2], line: Number(m[3]), column: Number(m[4]) })
    }
    if (out.length >= limit) break
  }
  return out
}
