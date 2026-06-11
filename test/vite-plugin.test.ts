// @vitest-environment node
import { mkdir, mkdtemp, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mooSourcemapUpload } from '../src/vite/plugin'

/** 在临时目录铺 .map 文件并构造 writeBundle 的 (output, bundle) 入参。 */
async function setupDist(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'moo-sm-'))
  const bundle: Record<string, unknown> = {}
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true })
    await writeFile(join(dir, name), content)
    bundle[name] = { type: 'asset' }
  }
  return { dir, bundle }
}

function okResponse(body: unknown = { ok: true, saved: 1, skipped: 0, errors: {} }, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

async function run(plugin: ReturnType<typeof mooSourcemapUpload>, dir: string, bundle: Record<string, unknown>) {
  // writeBundle 在测试里直接调用(rollup 钩子签名:(outputOptions, bundle))
  await (plugin.writeBundle as (o: unknown, b: unknown) => Promise<void>)({ dir }, bundle)
}

const OPTS = { endpoint: 'https://cloud.test/api/v1/', token: 'moo_ci', release: '1.2.3' }

describe('mooSourcemapUpload', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('只上传命中 include 的 .map,且 FormData 带 token/release/文件', async () => {
    const { dir, bundle } = await setupDist({
      'assets/index-abc.js.map': '{"version":3,"mappings":""}',
      'assets/index-abc.js': 'js code',
      'assets/style.css.map': '{}', // 默认 include 只收 .js.map
    })
    await run(mooSourcemapUpload(OPTS), dir, bundle)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: FormData }]
    expect(url).toBe('https://cloud.test/api/v1/sourcemaps/intake') // 末尾多余斜杠被归一
    expect(init.body.get('token')).toBe('moo_ci')
    expect(init.body.get('release')).toBe('1.2.3')
    expect(String(init.body.get('build_id'))).toMatch(/^[0-9a-f]{32}$/) // 构建集标识(文件名单哈希)
    const files = init.body.getAll('files[]') as File[]
    expect(files).toHaveLength(1)
    expect(files[0].name).toBe('index-abc.js.map') // 只取 basename(云端按产物名匹配)
  })

  it('超过单批上限时分多次请求', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 23; i++) files[`chunk-${i}.js.map`] = '{}'
    const { dir, bundle } = await setupDist(files)

    await run(mooSourcemapUpload(OPTS), dir, bundle)
    expect(fetchMock).toHaveBeenCalledTimes(2) // 20 + 3
    // 同一构建的两个分块 build_id 必须一致(云端按它做构建集替换,不一致会互删)
    const ids = fetchMock.mock.calls.map((c) => String((c[1] as { body: FormData }).body.get('build_id')))
    expect(ids[0]).toBe(ids[1])
  })

  it('deleteAfterUpload:上传成功后从产物目录删除 .map', async () => {
    const { dir, bundle } = await setupDist({ 'a.js.map': '{}', 'a.js': 'code' })

    await run(mooSourcemapUpload({ ...OPTS, deleteAfterUpload: true }), dir, bundle)
    expect(await readdir(dir)).toEqual(['a.js']) // .map 已删,js 保留
  })

  it('云端逐文件报错时:告警、不删 map;failOnError 才抛', async () => {
    // Response body 只能消费一次:必须每次调用都新建实例,不能 mockResolvedValue 复用
    fetchMock.mockImplementation(async () => okResponse({ ok: false, saved: 0, errors: { 'a.js.map': '太大' } }))
    const { dir, bundle } = await setupDist({ 'a.js.map': '{}' })

    await run(mooSourcemapUpload({ ...OPTS, deleteAfterUpload: true }), dir, bundle)
    expect(await readdir(dir)).toEqual(['a.js.map']) // 有失败 → 不删

    await expect(run(mooSourcemapUpload({ ...OPTS, failOnError: true }), dir, bundle)).rejects.toThrow('被云端拒绝')
  })

  it('默认失败不挡构建(网络错 / 403 / 非 VIP 都只告警);failOnError=true 时抛错', async () => {
    const { dir, bundle } = await setupDist({ 'a.js.map': '{}' })

    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await run(mooSourcemapUpload(OPTS), dir, bundle) // 不抛

    fetchMock.mockResolvedValueOnce(okResponse({ error: 'vip_required' }, 403))
    await run(mooSourcemapUpload(OPTS), dir, bundle) // 不抛
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('VIP'))

    fetchMock.mockResolvedValueOnce(okResponse({ error: 'boom' }, 500))
    await expect(run(mooSourcemapUpload({ ...OPTS, failOnError: true }), dir, bundle)).rejects.toThrow('HTTP 500')
  })

  it('没有 .map 产物时提示开启 build.sourcemap,不发请求', async () => {
    const { dir, bundle } = await setupDist({ 'a.js': 'code' })

    await run(mooSourcemapUpload(OPTS), dir, bundle)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('sourcemap'))
  })

  it('缺 endpoint/token/release 时跳过并告警', async () => {
    const { dir, bundle } = await setupDist({ 'a.js.map': '{}' })

    await run(mooSourcemapUpload({ ...OPTS, token: '' }), dir, bundle)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('第十二轮:monorepo app / 字节分块 / 413 与生效预期', () => {
  const okResp = () => new Response(JSON.stringify({ ok: true, saved: 1, skipped: 0, errors: {}, finalize_eta_seconds: 125 }), { status: 200 })

  it('分块受累计字节约束:两个 4MB map 拆成两个请求(防撞 post_max_size)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'moo-bytes-'))
    const bundle: Record<string, unknown> = {}
    for (const n of ['big1.js.map', 'big2.js.map', 'tiny.js.map']) {
      await writeFile(join(dir, n), n.startsWith('big') ? 'a'.repeat(4 * 1024 * 1024) : '{}')
      bundle[n] = { type: 'asset' }
    }
    const fetchMock = vi.fn(async () => okResp())
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await run(mooSourcemapUpload({ ...OPTS, injectDebugIds: false }), dir, bundle)
    expect(fetchMock).toHaveBeenCalledTimes(2) // [big1] + [big2, tiny],而非一锅 8MB
    vi.restoreAllMocks()
  })

  it('opts.app 随表单上传(monorepo 多应用分桶);413 给出调服务器限制的明话', async () => {
    const { dir, bundle } = await setupDist({ 'a.js.map': '{}' })
    const fetchMock = vi.fn(async () => okResp())
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await run(mooSourcemapUpload({ ...OPTS, app: 'admin', injectDebugIds: false }), dir, bundle)
    expect(((fetchMock.mock.calls[0][1] as RequestInit).body as FormData).get('app')).toBe('admin')
    vi.restoreAllMocks()

    const { dir: d2, bundle: b2 } = await setupDist({ 'b.js.map': '{}' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 413 })))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await run(mooSourcemapUpload({ ...OPTS, injectDebugIds: false }), d2, b2)
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('post_max_size')
    vi.restoreAllMocks()
  })

  it('上传成功日志带「约 2 分钟后生效」预期', async () => {
    const { dir, bundle } = await setupDist({ 'c.js.map': '{}' })
    vi.stubGlobal('fetch', vi.fn(async () => okResp()))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await run(mooSourcemapUpload({ ...OPTS, injectDebugIds: false }), dir, bundle)
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('生效')
    vi.restoreAllMocks()
  })
})
