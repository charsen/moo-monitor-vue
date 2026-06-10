import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MooClient } from '../src/core/client'
import { _resetSessionForTests } from '../src/core/session'
import type { FrontendErrorRecord } from '../src/core/types'

/** v0.4 采集面:点击/键盘/路由链路、HTTP 错误捕获、session 自动化、beforeSend。 */

const clients: MooClient[] = []

function makeClient(extra: Record<string, unknown> = {}) {
  const records: FrontendErrorRecord[] = []
  const client = new MooClient({
    endpoint: 'https://c.test/api/v1',
    token: 'tok12345',
    beforeSend: (e) => {
      records.push(e)
      return null // 拦下不真发,records 即断言对象
    },
    ...extra,
  })
  clients.push(client)
  // 探针:触发一次捕获,取此刻的 breadcrumbs 快照
  const crumbsNow = () => {
    client.captureException(new Error('probe'))
    return records[records.length - 1]?.breadcrumbs ?? []
  }
  return { client, records, crumbsNow }
}

beforeEach(() => {
  document.body.innerHTML = ''
  sessionStorage.clear()
  _resetSessionForTests()
})
afterEach(() => {
  clients.splice(0).forEach((c) => c.close()) // 防多实例监听器跨用例串 crumb
})

describe('点击 / 键盘 / 路由 行为链路', () => {
  it('点击 button 里的内层元素 → 归到按钮并带文本', () => {
    const { crumbsNow } = makeClient()
    document.body.innerHTML = '<button id="checkout" class="btn primary"><span>去结算</span></button>'
    document.querySelector('span')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    const click = crumbsNow().find((b) => b.category === 'click')
    expect(click?.message).toBe('button#checkout.btn.primary "去结算"')
  })

  it('Enter / Escape 记关键节点;输入聚合成一条且绝不记内容', () => {
    const { crumbsNow } = makeClient()
    document.body.innerHTML = '<input name="email"><input name="phone">'
    const [email, phone] = Array.from(document.querySelectorAll('input'))

    for (const key of ['s', 'e', 'c']) email.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    phone.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }))
    email.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    const crumbs = crumbsNow()
    const inputs = crumbs.filter((b) => b.category === 'input')
    expect(inputs.map((b) => b.message)).toEqual(['输入 → input[name=email]', '输入 → input[name=phone]']) // 同元素连续打字只记一条
    expect(crumbs.find((b) => b.category === 'key')?.message).toBe('Enter → input[name=email]')
    expect(JSON.stringify(crumbs)).not.toContain('"s"') // 按键内容绝不出现
  })

  it('非 KeyboardEvent 的 keydown(无 .key)不抛错、不产生自噪音错误', () => {
    const { records, crumbsNow } = makeClient()
    document.body.innerHTML = '<input name="q">'
    // 扩展/测试工具常用普通 Event 派发 keydown —— 此前 ke.key.length 会抛 TypeError,
    // 冒到 window.onerror 被 SDK 自己捕获成宿主错误。
    document.querySelector('input')!.dispatchEvent(new Event('keydown', { bubbles: true }))

    expect(crumbsNow().filter((b) => b.category === 'input' || b.category === 'key')).toHaveLength(0)
    expect(records.filter((r) => r.error.message !== 'probe')).toHaveLength(0) // 无自捕获
  })

  it('点击大容器:只取浅层首段文本,不物化整页 textContent', () => {
    const { crumbsNow } = makeClient()
    document.body.innerHTML = `<div id="page"><script>const SECRET_JS = 1</script><p>页首标题文案比较长会被截断到二十四个字符以内的样子</p><p>${'正文'.repeat(5000)}</p></div>`
    document.getElementById('page')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    const msg = crumbsNow().find((b) => b.category === 'click')?.message ?? ''
    expect(msg).toContain('div#page')
    expect(msg).not.toContain('SECRET_JS')        // script 内容不入轨迹
    expect(msg.length).toBeLessThanOrEqual(120)   // 不携带整页文本
    expect(msg).toContain('页首标题')              // 取到的是浅层首段
  })

  it('快捷键(ctrl/meta)不算输入', () => {
    const { crumbsNow } = makeClient()
    document.body.innerHTML = '<input name="q">'
    document.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }))

    expect(crumbsNow().filter((b) => b.category === 'input')).toHaveLength(0)
  })

  it('pushState / replaceState 记 from → to;close() 还原 history 方法', () => {
    const origPush = history.pushState
    const { client, crumbsNow } = makeClient()
    history.pushState({}, '', '/checkout?step=2')
    history.replaceState({}, '', '/checkout?step=3')

    const nav = crumbsNow().filter((b) => b.category === 'navigation')
    expect(nav[0]?.message).toMatch(/ → \/checkout\?step=2$/)
    expect(nav[1]?.message).toBe('/checkout?step=2 → /checkout?step=3')

    client.close()
    expect(history.pushState).toBe(origPush)
  })

  it('重复 init 不叠加包裹 history(哨兵)', () => {
    makeClient()
    const once = history.pushState
    makeClient()
    expect(history.pushState).toBe(once)
  })
})

describe('HTTP 响应错误自动捕获', () => {
  function withFetch(status: number) {
    const base = vi.fn(() => Promise.resolve({ ok: status < 400, status } as Response))
    window.fetch = base as unknown as typeof fetch
    return base
  }

  it('默认 ≥500 捕获为 HttpError(合成栈,无 SDK 帧),<500 只记 breadcrumb', async () => {
    withFetch(502)
    const { records, crumbsNow } = makeClient()
    await window.fetch('https://api.test/orders/123')

    const http = records.find((r) => r.error.name === 'HttpError')
    expect(http?.error.message).toBe('GET https://api.test/orders/123 502')
    expect(http?.error.handled).toBe(false)
    expect(http?.frames).toBeUndefined() // 非 Error 输入 → 合成栈被丢弃,不带 SDK 内部帧
    expect(http?.payload?.extra).toMatchObject({ status: 502, method: 'GET' })

    withFetch(404)
    const { records: r2, crumbsNow: c2 } = makeClient()
    await window.fetch('https://api.test/missing')
    expect(r2.find((r) => r.error.name === 'HttpError')).toBeUndefined()
    expect(c2().find((b) => b.category === 'fetch' && b.level === 'error')).toBeTruthy() // breadcrumb 仍在
    void crumbsNow
  })

  it('min 可降到 400;false 完全关闭', async () => {
    withFetch(404)
    const { records } = makeClient({ httpErrors: { min: 400 } })
    await window.fetch('https://api.test/x')
    expect(records.find((r) => r.error.name === 'HttpError')).toBeTruthy()

    withFetch(500)
    const { records: off } = makeClient({ httpErrors: false })
    await window.fetch('https://api.test/y')
    expect(off.find((r) => r.error.name === 'HttpError')).toBeUndefined()
  })

  it('HttpError 指纹分组用去 query/hash 的 URL;extra 不携带完整 URL', async () => {
    withFetch(502)
    const { records } = makeClient()
    await window.fetch('https://api.test/search?q=abc&cursor=xyz#frag')

    const http = records.find((r) => r.error.name === 'HttpError')
    expect(http?.error.message).toBe('GET https://api.test/search 502') // query/hash 不进指纹
    expect(JSON.stringify(http?.payload)).not.toContain('cursor')
  })

  it('连续同一 fetch(轮询)折叠成一条 ×N,插入其他轨迹后另起一条', async () => {
    withFetch(504)
    const { crumbsNow } = makeClient({ httpErrors: false })
    await window.fetch('https://api.test/poll')
    await window.fetch('https://api.test/poll')
    await window.fetch('https://api.test/poll')
    document.body.innerHTML = '<button id="b">B</button>'
    document.getElementById('b')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await window.fetch('https://api.test/poll')

    const crumbs = crumbsNow()
    const fetches = crumbs.filter((b) => b.category === 'fetch')
    expect(fetches).toHaveLength(2) // 3 连击折叠成一条,点击之后另起一条
    expect(fetches[0].message).toBe('GET https://api.test/poll 504 ×3')
    expect(fetches[1].message).toBe('GET https://api.test/poll 504')
  })

  it('对 SDK 自身上报地址不捕获(防死循环)', async () => {
    withFetch(503)
    const { records } = makeClient()
    await window.fetch('https://c.test/api/v1/frontend-errors/intake')
    expect(records.find((r) => r.error.name === 'HttpError')).toBeUndefined()
  })
})

describe('session 自动化', () => {
  it('自动生成 24 位 hex,同会话内稳定,且跨实例复用(sessionStorage)', () => {
    const { client, records } = makeClient()
    client.captureException(new Error('a'))
    client.captureException(new Error('b'))
    const sid = records[0].user?.session_id
    expect(sid).toMatch(/^[0-9a-f]{24}$/)
    expect(records[1].user?.session_id).toBe(sid)

    const { client: c2, records: r2 } = makeClient()
    c2.captureException(new Error('c'))
    expect(r2[0].user?.session_id).toBe(sid) // 新实例(如刷新后 re-init)同标签页同会话
  })

  it('setUser 的 sessionId 优先;autoSession=false 且未 setUser 时不带 user', () => {
    const { client, records } = makeClient()
    client.setUser({ id: 1, sessionId: 'custom-sid' })
    client.captureException(new Error('x'))
    expect(records[0].user?.session_id).toBe('custom-sid')

    const { client: c2, records: r2 } = makeClient({ autoSession: false })
    c2.captureException(new Error('y'))
    expect(r2[0].user).toBeUndefined()
  })
})

describe('选项钳制(footgun 防护)', () => {
  it('httpErrors.min 钳到 ≥400(min:0 不再把 2xx 捕成错误);maxBatch 钳到云端上限 200', async () => {
    const { resolveOptions } = await import('../src/core/types')
    const base = { endpoint: 'x', token: 't' }
    expect(resolveOptions({ ...base, httpErrors: { min: 0 } }).httpErrorsMin).toBe(400)
    expect(resolveOptions({ ...base, httpErrors: { min: 404 } }).httpErrorsMin).toBe(404)
    expect(resolveOptions({ ...base, maxBatch: 999 }).maxBatch).toBe(200)
    expect(resolveOptions({ ...base, maxBatch: 0 }).maxBatch).toBe(1)
  })
})

describe('beforeSend(补测试缺口)', () => {
  it('可改写记录;返回 null 丢弃', async () => {
    const beacon = vi.fn(() => true)
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true })

    const client = new MooClient({
      endpoint: 'https://c.test/api/v1', token: 'tok12345',
      beforeSend: (e) => {
        if (e.error.message.includes('drop-me')) return null
        e.error.message = '[改写] ' + e.error.message
        return e
      },
    })
    clients.push(client)

    client.captureException(new Error('keep'))
    client.captureException(new Error('drop-me'))
    client.flush(true)

    expect(beacon).toHaveBeenCalledTimes(1)
    // beacon body 是 Blob;jsdom 的 Blob 无 .text(),用 FileReader 读
    const text = await new Promise<string>((resolve) => {
      const fr = new FileReader()
      fr.onload = () => resolve(String(fr.result))
      fr.readAsText(beacon.mock.calls[0][1] as Blob)
    })
    const body = JSON.parse(text)
    expect(body.records).toHaveLength(1) // drop-me 被丢弃
    expect(body.records[0].error.message).toBe('[改写] keep')
  })
})
