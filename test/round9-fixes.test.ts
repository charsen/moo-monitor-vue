// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Scope } from '../src/core/scope'
import { Queue } from '../src/core/queue'
import { normalize } from '../src/core/normalize'
import { parseUA } from '../src/core/uaParse'
import MooMonitor from '../src/vue/plugin'
import { mooSourcemapUpload } from '../src/vite/plugin'
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FrontendErrorRecord } from '../src/core/types'

/** 第九轮审查回归:6 个问题逐一验证。 */

afterEach(() => vi.unstubAllGlobals())

describe('① setExtra 钳制 + 截断分级丢弃', () => {
  it('超大 extra 被占位替换;不可序列化不毒翻记录', () => {
    const s = new Scope()
    s.setExtra('snapshot', { big: 'x'.repeat(20000) })
    expect(s.extra.snapshot).toBe('[truncated: oversized extra]')

    const circular: Record<string, unknown> = {}
    circular.self = circular
    s.setExtra('loop', circular)
    expect(s.extra.loop).toBe('[unserializable extra]')

    s.setExtra('ok', { a: 1 }) // 正常值原样
    expect(s.extra.ok).toEqual({ a: 1 })
  })

  it('截断二轮先丢 payload,frames/breadcrumbs 得以保住', () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200, headers: { get: () => null } }))
    vi.stubGlobal('fetch', fetchMock)
    const q = new Queue('https://c.test/x', 'tok', 999999, 999999)
    q.add({
      hash: 'aaaaaaaaaaaa',
      error: { name: 'E', message: 'm', handled: false, severity: 'error' },
      page: {}, client: {}, context: {},
      frames: [{ file: 'app.js', line: 1, column: 1, function: 'f' }],
      breadcrumbs: [{ category: 'click', message: 'b' }],
      payload: { extra: { huge: 'x'.repeat(60000) } }, // 肇事者是 payload
    } as FrontendErrorRecord)
    q.flush()

    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).records[0]
    expect(sent.payload).toBeUndefined()       // 只丢 payload
    expect(sent.frames).toBeTruthy()           // 栈保住了(此前连坐被丢)
    expect(sent.breadcrumbs).toBeTruthy()      // 轨迹保住了
  })
})

describe('② Vite 插件:删 map 后剥 sourceMappingURL 注释', () => {
  const OPTS = { endpoint: 'https://cloud.test/api/v1', token: 'ci', release: '1.0.0', deleteAfterUpload: true }
  const ok = () => new Response(JSON.stringify({ ok: true, saved: 1, skipped: 0, errors: {} }), { status: 200 })

  async function run(sourcemapSetting: boolean | 'hidden') {
    const dir = await mkdtemp(join(tmpdir(), 'moo-r9-'))
    await writeFile(join(dir, 'a.js'), 'console.log(1)\n//# sourceMappingURL=a.js.map\n')
    await writeFile(join(dir, 'a.js.map'), '{}')
    vi.stubGlobal('fetch', vi.fn(async () => ok()))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const plugin = mooSourcemapUpload(OPTS)
    ;(plugin.configResolved as (c: unknown) => void)({ build: { sourcemap: sourcemapSetting } })
    await (plugin.writeBundle as (o: unknown, b: unknown) => Promise<void>)({ dir }, { 'a.js.map': {}, 'a.js': {} })
    return dir
  }

  it("sourcemap:true → 删 map 同时剥掉 JS 尾部注释(不再 404);'hidden' 不动 JS", async () => {
    const dir = await run(true)
    expect(await readdir(dir)).toEqual(['a.js'])
    const js = await readFile(join(dir, 'a.js'), 'utf8')
    expect(js).not.toContain('sourceMappingURL') // 注释被剥
    expect(js).toContain('console.log(1)')
    vi.restoreAllMocks()

    const dir2 = await run('hidden')
    const js2 = await readFile(join(dir2, 'a.js'), 'utf8')
    expect(js2).toContain('sourceMappingURL') // hidden 下 JS 本就不该被碰(此处文件是手造的)
    vi.restoreAllMocks()
  })
})

describe('③ __mooSeen 不泄漏进非 Error 抛掷物的消息', () => {
  it('router.onError 标记后,对象序列化出的 message 不含内部标记', () => {
    const records: FrontendErrorRecord[] = []
    let handler: ((e: unknown) => void) | undefined
    const app = { provide: vi.fn(), config: { globalProperties: {} as Record<string, unknown>, errorHandler: undefined } }
    ;(MooMonitor as { install: (a: unknown, o: unknown) => void }).install(app, {
      endpoint: 'https://c.test/api/v1', token: 'tok12345',
      beforeSend: (e: FrontendErrorRecord) => (records.push(e), null),
      router: { onError: (h: (e: unknown) => void) => (handler = h) },
    })

    handler!({ code: 403, reason: 'forbidden' }) // 非 Error 抛掷物
    expect(records[0].error.message).toContain('403')
    expect(records[0].error.message).not.toContain('__mooSeen') // 内部标记不进数据/指纹
  })
})

describe('④ stableFile:不误伤人工命名,兼容 .min.js', () => {
  const withStack = (file: string) => {
    const e = new Error('boom')
    e.stack = `Error: boom\n    at render (https://x.test/assets/${file}:1:100)`
    return e
  }

  it('user-settings.js(无数字)不再被剥;.min.js 带 hash 的也能剥', () => {
    // 人工命名:settings 段无数字 → 保留,与真 user.js 指纹不同
    expect(normalize(withStack('user-settings.js'), {}).hash).not.toBe(normalize(withStack('user.js'), {}).hash)
    // .min.js:hash 段照剥 → 跨发版稳定
    expect(normalize(withStack('app-Df3kZ2L0.min.js'), {}).hash).toBe(normalize(withStack('app-Aa1Bb2Cc.min.js'), {}).hash)
  })
})

describe('⑤ queue 滞留路径补 arm(行为可观测:rejected 后回执不等下个 add)', () => {
  it('422 丢弃后自动安排下一轮 flush,onDrop 不需要等新错误才响', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 422, headers: { get: () => null } })))
    const drops: number[] = []
    const q = new Queue('https://c.test/x', 'tok', 50, 20, (n) => drops.push(n))
    q.add({ hash: 'aaaaaaaaaaaa', error: { name: 'E', message: 'm', handled: false, severity: 'error' }, page: {}, client: {}, context: {} } as FrontendErrorRecord)
    q.flush()
    await vi.advanceTimersByTimeAsync(10) // 让 fetch then 落地(rejected → dropped+arm)
    await vi.advanceTimersByTimeAsync(60) // 到点自动 flush → 上报 dropped
    expect(drops).toEqual([1])
    vi.useRealTimers()
  })
})

describe('⑥ 国产内嵌浏览器识别', () => {
  it('微信 / 钉钉 / QQ / UC 不再统统算成 Chrome', () => {
    const base = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36'
    expect(parseUA(`${base} MicroMessenger/8.0.49`).browser).toBe('WeChat')
    expect(parseUA(`${base} DingTalk/7.5.0`).browser).toBe('DingTalk')
    expect(parseUA(`${base} MQQBrowser/14.0`).browser).toBe('QQBrowser')
    expect(parseUA(`${base} UCBrowser/16.3.0`).browser).toBe('UCBrowser')
    expect(parseUA(base).browser).toBe('Chrome') // 纯 Chrome 不受影响
  })
})
