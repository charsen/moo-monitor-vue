// @vitest-environment node
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mooSourcemapUpload, resolveMooRelease } from '../src/vite/plugin'

const execFileAsync = promisify(execFile)

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
    expect(init.body.get('expected_files')).toBe('1')
    expect(init.body.get('source_mode')).toBe('context')
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

  it('archiveDir:按 release/app 目录归档 sourcemap 和 manifest', async () => {
    const { dir, bundle } = await setupDist({ 'assets/a.js.map': '{"version":3,"mappings":""}', 'assets/a.js': 'code' })
    const archive = await mkdtemp(join(tmpdir(), 'moo-sm-archive-'))

    await run(mooSourcemapUpload({ ...OPTS, app: 'admin/web', archiveDir: archive, deleteAfterUpload: true }), dir, bundle)

    const target = join(archive, '1.2.3', 'admin_web')
    expect((await readdir(target)).sort()).toEqual(['a.js.map', 'manifest.json'])
    const manifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8')) as { release: string; app: string; files: string[] }
    expect(manifest.release).toBe('1.2.3')
    expect(manifest.app).toBe('admin/web')
    expect(manifest.files).toEqual(['a.js.map'])
  })

  it('sourceMode=position:上传和归档前剥离 sourcesContent', async () => {
    const { dir, bundle } = await setupDist({
      'assets/a.js.map': JSON.stringify({ version: 3, sources: ['src/App.vue'], sourcesContent: ['secret source'], names: [], mappings: '' }),
      'assets/a.js': 'code',
    })

    await run(mooSourcemapUpload({ ...OPTS, sourceMode: 'position', injectDebugIds: false }), dir, bundle)

    expect(JSON.parse(await readFile(join(dir, 'assets/a.js.map'), 'utf8')).sourcesContent).toBeUndefined()
    const form = (fetchMock.mock.calls[0][1] as { body: FormData }).body
    expect(form.get('source_mode')).toBe('position')
    const uploaded = form.get('files[]') as File
    expect(await uploaded.text()).not.toContain('sourcesContent')
  })

  it('strict:云端健康检查不达标时让构建失败', async () => {
    fetchMock.mockImplementation(async () =>
      okResponse({
        ok: true,
        saved: 1,
        skipped: 0,
        errors: {},
        health: { current_build_artifacts: 1, missing_files: 1, debug_id_coverage: 0.5, duplicate_debug_ids: 0 },
      }),
    )
    const { dir, bundle } = await setupDist({ 'a.js.map': '{}', 'b.js.map': '{}' })

    await expect(run(mooSourcemapUpload({ ...OPTS, strict: true, injectDebugIds: false }), dir, bundle)).rejects.toThrow('strict check failed')
  })

  it('strict:云端未返回 health(版本过旧)时同样失败,不静默放行', async () => {
    fetchMock.mockImplementation(async () => okResponse({ ok: true, saved: 1, skipped: 0, errors: {} }))
    const { dir, bundle } = await setupDist({ 'a.js.map': '{}' })

    await expect(run(mooSourcemapUpload({ ...OPTS, strict: true, injectDebugIds: false }), dir, bundle)).rejects.toThrow('未返回 health')
  })

  it('strict:上传中断(HTTP 500)也直接失败,不受 failOnError 默认值影响', async () => {
    fetchMock.mockImplementation(async () => okResponse({ ok: false }, 500))
    const { dir, bundle } = await setupDist({ 'a.js.map': '{}' })

    await expect(run(mooSourcemapUpload({ ...OPTS, strict: true, injectDebugIds: false }), dir, bundle)).rejects.toThrow('HTTP 500')
  })

  it('archiveDir 归档失败:默认只告警不挡构建,上传照常', async () => {
    const { dir, bundle } = await setupDist({ 'a.js.map': '{}' })
    const blocker = join(dir, 'archive-blocker')
    await writeFile(blocker, 'not a dir') // archiveDir 指向一个文件 → mkdir 失败

    await run(mooSourcemapUpload({ ...OPTS, archiveDir: blocker, injectDebugIds: false }), dir, bundle)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes('归档 sourcemap 失败'))).toBe(true)
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

  it('多 output 构建(同插件实例二次 writeBundle,build_id 不同)告警互清构建集(P3.5)', async () => {
    const plugin = mooSourcemapUpload({ ...OPTS, injectDebugIds: false })
    const modern = await setupDist({ 'modern-a.js.map': '{}' })
    const legacy = await setupDist({ 'legacy-b.js.map': '{}' }) // 不同文件名 → 不同 build_id

    await run(plugin, modern.dir, modern.bundle) // 首个 output:记录 build_id,不告警
    await run(plugin, legacy.dir, legacy.bundle) // 第二个 output:build_id 不同 → 告警

    const warns = vi.mocked(console.warn).mock.calls.map((c) => String(c[0])).join('\n')
    expect(warns).toContain('多次 writeBundle')
    expect(warns).toContain('app')
  })

  it('不同目录同名 .map:检测 basename 冲突并告警(P3.6)', async () => {
    const { dir, bundle } = await setupDist({
      'modern/index.js.map': '{}',
      'legacy/index.js.map': '{}', // 不同目录、同 basename
    })
    await run(mooSourcemapUpload({ ...OPTS, injectDebugIds: false }), dir, bundle)

    const warns = vi.mocked(console.warn).mock.calls.map((c) => String(c[0])).join('\n')
    expect(warns).toContain('index.js.map')
    expect(warns).toMatch(/同名|覆盖|二义/)
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

// 源自第八轮审查回归(Vite 插件失败处理)。
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

describe('resolveMooRelease', () => {
  async function git(cwd: string, args: string[]) {
    const { stdout } = await execFileAsync('git', args, { cwd })
    return String(stdout).trim()
  }

  it('按最近 git tag + 8 位 commit hash 生成 release', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'moo-release-'))
    await git(dir, ['init'])
    await git(dir, ['config', 'user.email', 'test@example.com'])
    await git(dir, ['config', 'user.name', 'Test'])
    await writeFile(join(dir, 'a.txt'), 'a')
    await git(dir, ['add', 'a.txt'])
    await git(dir, ['commit', '-m', 'init'])
    await git(dir, ['tag', 'v1.2.3'])
    await writeFile(join(dir, 'a.txt'), 'b')
    await git(dir, ['commit', '-am', 'next'])

    const commit = await git(dir, ['rev-parse', '--short=8', 'HEAD'])

    await expect(resolveMooRelease({ cwd: dir })).resolves.toBe(`v1.2.3-${commit}`)
  })

  it('找不到 tag 时使用 fallbackTag', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'moo-release-'))
    await git(dir, ['init'])
    await git(dir, ['config', 'user.email', 'test@example.com'])
    await git(dir, ['config', 'user.name', 'Test'])
    await writeFile(join(dir, 'a.txt'), 'a')
    await git(dir, ['add', 'a.txt'])
    await git(dir, ['commit', '-m', 'init'])

    const commit = await git(dir, ['rev-parse', '--short=8', 'HEAD'])

    await expect(resolveMooRelease({ cwd: dir, fallbackTag: 'local' })).resolves.toBe(`local-${commit}`)
  })

  it('describe 找不到可达 tag 时默认退回最新本地 tag', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'moo-release-'))
    await git(dir, ['init'])
    await git(dir, ['config', 'user.email', 'test@example.com'])
    await git(dir, ['config', 'user.name', 'Test'])
    await writeFile(join(dir, 'a.txt'), 'a')
    await git(dir, ['add', 'a.txt'])
    await git(dir, ['commit', '-m', 'main'])
    const mainBranch = await git(dir, ['branch', '--show-current'])
    await git(dir, ['checkout', '--orphan', 'release-line'])
    await writeFile(join(dir, 'b.txt'), 'b')
    await git(dir, ['add', 'b.txt'])
    await git(dir, ['commit', '-m', 'tagged'])
    await git(dir, ['tag', 'v9.9.9'])
    await git(dir, ['checkout', mainBranch])

    const commit = await git(dir, ['rev-parse', '--short=8', 'HEAD'])

    await expect(resolveMooRelease({ cwd: dir, tagPrefix: 'v' })).resolves.toBe(`v9.9.9-${commit}`)
    await expect(resolveMooRelease({ cwd: dir, tagPrefix: 'v', fallbackToLatestTag: false, fallbackTag: 'local' })).resolves.toBe(`local-${commit}`)
  })
})
