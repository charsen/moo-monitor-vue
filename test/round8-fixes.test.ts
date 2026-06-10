// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Queue } from '../src/core/queue'
import { BreadcrumbBuffer } from '../src/core/breadcrumbs'
import { parseStack } from '../src/core/stacktrace'
import { MooClient } from '../src/core/client'
import { mooSourcemapUpload } from '../src/vite/plugin'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FrontendErrorRecord } from '../src/core/types'

/** 第八轮审查回归:6 个问题逐一验证。 */

const rec = (hash: string, extra: Partial<FrontendErrorRecord> = {}): FrontendErrorRecord =>
  ({ hash, error: { name: 'E', message: 'm', handled: false, severity: 'error' }, page: {}, client: {}, context: {}, ...extra }) as FrontendErrorRecord

afterEach(() => vi.unstubAllGlobals())

describe('① 缓冲满:挤掉最旧、保留最新', () => {
  it('溢出后缓冲里是最新的 200 条(此前留最旧丢最新)', () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200, headers: { get: () => null } }))
    vi.stubGlobal('fetch', fetchMock)
    const q = new Queue('https://c.test/x', 'tok', 999999, 999999) // 不自动 flush
    for (let i = 0; i < 205; i++) q.add(rec(`h${String(i).padStart(10, '0')}`))

    expect(q.size()).toBe(200)
    q.flush()
    const sent: FrontendErrorRecord[] = []
    for (const call of fetchMock.mock.calls) {
      sent.push(...JSON.parse((call[1] as RequestInit).body as string).records)
    }
    const hashes = sent.map((r) => r.hash)
    expect(hashes).toContain('h0000000204') // 最新的还在
    expect(hashes).not.toContain('h0000000000') // 最旧的被挤掉
  })
})

describe('② 超大记录:url 纳入裁剪;仍超限则丢弃不再发', () => {
  it('超长 page.url 被截到 2048;两轮截断后仍超限的记录被丢弃并计入 onDrop', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200, headers: { get: () => null } }))
    vi.stubGlobal('fetch', fetchMock)
    const drops: number[] = []
    const q = new Queue('https://c.test/x', 'tok', 999999, 999999, (n) => drops.push(n))

    q.add(rec('aaaaaaaaaaaa', { page: { url: 'https://x/?q=' + 'a'.repeat(60000) } }))
    // beforeSend 注入巨型不可裁剪字段(顶层自定义键,truncateRecord 两轮都不会动它)
    q.add(rec('bbbbbbbbbbbb', { user: { name: 'x'.repeat(60000) } } as never))
    q.flush()

    const sent: FrontendErrorRecord[] = []
    for (const call of fetchMock.mock.calls) {
      sent.push(...JSON.parse((call[1] as RequestInit).body as string).records)
    }
    const a = sent.find((r) => r.hash === 'aaaaaaaaaaaa')
    expect(a?.page.url?.length).toBeLessThanOrEqual(2048) // url 截断后照发
    expect(sent.find((r) => r.hash === 'bbbbbbbbbbbb')).toBeUndefined() // 不可救的丢弃

    q.add(rec('cccccccccccc'))
    q.flush() // 下一轮上报 dropped
    expect(drops).toEqual([1])
  })
})

describe('③ hash 路由的导航轨迹', () => {
  it('只改 hash 的跳转也记 from → to(createWebHashHistory 场景)', () => {
    const records: FrontendErrorRecord[] = []
    const client = new MooClient({
      endpoint: 'https://c.test/api/v1', token: 'tok12345',
      beforeSend: (e) => (records.push(e), null),
    })
    history.pushState({}, '', location.pathname + '#/cart')
    history.pushState({}, '', location.pathname + '#/checkout')
    client.captureException(new Error('probe'))

    const nav = (records[0].breadcrumbs ?? []).filter((b) => b.category === 'navigation')
    expect(nav.length).toBeGreaterThanOrEqual(2)
    expect(nav[nav.length - 1].message).toContain('#/cart → ')
    expect(nav[nav.length - 1].message).toContain('#/checkout')
    client.close()
  })
})

describe('④ breadcrumb message 钳制', () => {
  it('超长 message(data: URL 等)截到 300', () => {
    const buf = new BreadcrumbBuffer(5)
    buf.add({ category: 'fetch', message: 'GET data:image/png;base64,' + 'A'.repeat(50000) + ' 200' })
    expect(buf.all()[0].message!.length).toBeLessThanOrEqual(301)
  })
})

describe('⑤ Vite 插件失败处理', () => {
  async function setup(maps: Record<string, string>) {
    const dir = await mkdtemp(join(tmpdir(), 'moo-r8-'))
    const bundle: Record<string, unknown> = {}
    for (const [n, c] of Object.entries(maps)) {
      await writeFile(join(dir, n), c)
      bundle[n] = { type: 'asset' }
    }
    return { dir, bundle }
  }
  const OPTS = { endpoint: 'https://cloud.test/api/v1', token: 'ci', release: '1.0.0' }
  const resp = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

  it('429 等待后重试一次成功;错误信息兼容 Laravel 的 message 字段', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resp(429, { message: 'Too Many Attempts.' }))
      .mockResolvedValueOnce(resp(200, { ok: true, saved: 1, skipped: 0, errors: {} }))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { dir, bundle } = await setup({ 'a.js.map': '{}' })
    await (mooSourcemapUpload(OPTS).writeBundle as (o: unknown, b: unknown) => Promise<void>)({ dir }, bundle)

    expect(fetchMock).toHaveBeenCalledTimes(2) // 429 → 等 2s 重试一次 → 成功
    vi.restoreAllMocks()
  }, 8000)

  it('中途失败给出半传摘要(已传 N/共 M)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resp(200, { ok: true, saved: 20, skipped: 0, errors: {} }))
      .mockResolvedValueOnce(resp(500, { message: 'Server Error' }))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const maps: Record<string, string> = {}
    for (let i = 0; i < 25; i++) maps[`c${i}.js.map`] = '{}' // 2 个 chunk(20+5)
    const { dir, bundle } = await setup(maps)
    await (mooSourcemapUpload(OPTS).writeBundle as (o: unknown, b: unknown) => Promise<void>)({ dir }, bundle)

    const all = warnSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(all).toContain('已传 20/25')
    expect(all).toContain('Server Error') // message 字段被读出
    vi.restoreAllMocks()
  })
})

describe('⑥ 无列号帧解析', () => {
  it('"at file:line" 解析成 file+line 帧,不再把 URL 当函数名', () => {
    const frames = parseStack('Error: x\n    at https://x.test/app.js:10\n    at run (https://x.test/app.js:22)\n    at fn (native)')
    expect(frames[0]).toEqual({ function: '?', file: 'https://x.test/app.js', line: 10 })
    expect(frames[1]).toEqual({ function: 'run', file: 'https://x.test/app.js', line: 22 })
    expect(frames[2]).toEqual({ function: 'fn', file: 'native' }) // native 兜底不受影响
  })
})
