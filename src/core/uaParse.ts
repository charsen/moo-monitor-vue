/** 轻量 UA 解析:从 navigator.userAgent 取浏览器 + 版本 + 系统 + 设备类型(够用即可)。 */
export function parseUA(ua: string): { browser?: string; browser_version?: string; os?: string; device?: string } {
  const res: { browser?: string; browser_version?: string; os?: string; device?: string } = {}
  let m: RegExpExecArray | null

  if ((m = /Edg(?:e|A|iOS)?\/([\d.]+)/.exec(ua))) {
    res.browser = 'Edge'
    res.browser_version = m[1]
  } else if ((m = /OPR\/([\d.]+)/.exec(ua)) || (m = /Opera[/ ]([\d.]+)/.exec(ua))) {
    res.browser = 'Opera'
    res.browser_version = m[1]
  } else if ((m = /CriOS\/([\d.]+)/.exec(ua))) {
    // iOS 上的 Chrome / Firefox 用 CriOS / FxiOS 标识(UA 不含 Chrome/ Firefox/),
    // 此前落到 Version/x Safari 分支被误判成 Safari。
    res.browser = 'Chrome'
    res.browser_version = m[1]
  } else if ((m = /FxiOS\/([\d.]+)/.exec(ua))) {
    res.browser = 'Firefox'
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

  // 注意顺序:iOS UA 含「like Mac OS X」,必须先判 iPhone/iPad 再判 macOS,否则被误判成 macOS。
  if (/Windows NT/.test(ua)) res.os = 'Windows'
  else if (/Android/.test(ua)) res.os = 'Android'
  else if (/iPhone|iPad|iPod/.test(ua)) res.os = 'iOS'
  else if (/Mac OS X/.test(ua)) res.os = 'macOS'
  else if (/Linux/.test(ua)) res.os = 'Linux'

  // 设备类型(粗分):平板 / 手机 / 桌面 —— 填补云端 device 列(此前恒空)。
  if (/iPad|Tablet/.test(ua)) res.device = 'Tablet'
  else if (/Mobi|Android|iPhone|iPod/.test(ua)) res.device = 'Mobile'
  else res.device = 'Desktop'

  return res
}
