/** 轻量 UA 解析:从 navigator.userAgent 取浏览器 + 版本 + 系统(够用即可,不追求全覆盖)。 */
export function parseUA(ua: string): { browser?: string; browser_version?: string; os?: string } {
  const res: { browser?: string; browser_version?: string; os?: string } = {}
  let m: RegExpExecArray | null

  if ((m = /Edg(?:e|A|iOS)?\/([\d.]+)/.exec(ua))) {
    res.browser = 'Edge'
    res.browser_version = m[1]
  } else if ((m = /OPR\/([\d.]+)/.exec(ua)) || (m = /Opera[/ ]([\d.]+)/.exec(ua))) {
    res.browser = 'Opera'
    res.browser_version = m[1]
  } else if ((m = /Firefox\/([\d.]+)/.exec(ua))) {
    res.browser = 'Firefox'
    res.browser_version = m[1]
  } else if ((m = /Chrome\/([\d.]+)/.exec(ua))) {
    res.browser = 'Chrome'
    res.browser_version = m[1]
  } else if ((m = /Version\/([\d.]+).*Safari/.exec(ua))) {
    res.browser = 'Safari'
    res.browser_version = m[1]
  }

  if (/Windows NT/.test(ua)) res.os = 'Windows'
  else if (/Mac OS X/.test(ua)) res.os = 'macOS'
  else if (/Android/.test(ua)) res.os = 'Android'
  else if (/iPhone|iPad|iPod/.test(ua)) res.os = 'iOS'
  else if (/Linux/.test(ua)) res.os = 'Linux'

  return res
}
