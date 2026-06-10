// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mooSourcemapUpload } from '../src/vite/plugin'
import { debugIdForFile, _resetDebugIdsForTests } from '../src/core/debugIds'
import { normalize } from '../src/core/normalize'

/** Debug ID 全链路(A):插件注入 → 运行时注册表 → 帧携带。 */

afterEach(() => {
  vi.unstubAllGlobals()
  _resetDebugIdsForTests()
  delete (window as { _mooDebugIds?: unknown })._mooDebugIds
})

describe('插件注入', () => {
  const OPTS = { endpoint: 'https://cloud.test/api/v1', token: 'ci', release: '1.0.0' }
  const ok = () => new Response(JSON.stringify({ ok: true, saved: 1, skipped: 0, errors: {} }), { status: 200 })

  async function build() {
    const dir = await mkdtemp(join(tmpdir(), 'moo-did-'))
    await writeFile(join(dir, 'a.js'), 'console.log(1)\n//# sourceMappingURL=a.js.map\n')
    await writeFile(join(dir, 'a.js.map'), JSON.stringify({ version: 3, sources: ['src/a.ts'], names: [], mappings: 'AAAA' }))
    return dir
  }
  async function run(dir: string) {
    vi.stubGlobal('fetch', vi.fn(async () => ok()))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await (mooSourcemapUpload(OPTS).writeBundle as (o: unknown, b: unknown) => Promise<void>)(
      { dir },
      { 'a.js.map': {}, 'a.js': {} },
    )
    vi.restoreAllMocks()
  }

  it('注入 snippet/注释/映射偏移补偿,且幂等、确定性', async () => {
    const dir = await build()
    const originalJs = await readFile(join(dir, 'a.js'), 'utf8')
    await run(dir)

    const js = await readFile(join(dir, 'a.js'), 'utf8')
    const map = JSON.parse(await readFile(join(dir, 'a.js.map'), 'utf8'))
    expect(map.debug_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(map.mappings.startsWith(';')).toBe(true) // 头部新增一行 → mappings 前补 ';'
    expect(js).toContain(`window._mooDebugIds[e]="${map.debug_id}"`)
    // debugId 注释在 sourceMappingURL 之前
    expect(js.indexOf(`//# debugId=${map.debug_id}`)).toBeLessThan(js.indexOf('//# sourceMappingURL='))

    await run(dir) // 重跑(watch 场景):map 已有 debug_id → 跳过,不重复注入
    const js2 = await readFile(join(dir, 'a.js'), 'utf8')
    expect(js2).toBe(js)
    expect((js2.match(/new Error\(\)\.stack/g) || []).length).toBe(1) // snippet 只注入一次

    // 确定性:同内容产物在另一目录注入,得到同一 ID
    const dir2 = await build()
    void originalJs
    await run(dir2)
    const map2 = JSON.parse(await readFile(join(dir2, 'a.js.map'), 'utf8'))
    expect(map2.debug_id).toBe(map.debug_id)
  })
})

describe('运行时注册表 → 帧携带 debug_id', () => {
  it('从注册表 stack 键解析 chunk 加载 URL,normalize 给帧附 ID;新 chunk 懒加载后缓存重建', () => {
    const url = 'https://x.test/assets/index-abc.js'
    ;(window as { _mooDebugIds?: Record<string, string> })._mooDebugIds = {
      [`Error\n    at ${url}:1:120`]: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    }

    expect(debugIdForFile(url)).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    expect(debugIdForFile('https://x.test/assets/other.js')).toBeUndefined()

    const err = new Error('boom')
    err.stack = `Error: boom\n    at render (${url}:1:200)`
    const rec = normalize(err, {})
    expect(rec.frames?.[0].debug_id).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')

    // 懒加载新 chunk:注册表新增键 → 缓存按键数变化重建
    const url2 = 'https://x.test/assets/lazy-def.js'
    ;(window as unknown as { _mooDebugIds: Record<string, string> })._mooDebugIds[`Error\n    at ${url2}:1:50`] = 'ffffffff-0000-1111-2222-333333333333'
    expect(debugIdForFile(url2)).toBe('ffffffff-0000-1111-2222-333333333333')
  })
})
