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

function json(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers })
}

type FlowOverrides = {
  ticket?: (payload: Record<string, unknown>, call: number) => Response | Promise<Response>
  qiniu?: (form: FormData) => Response | Promise<Response>
  confirm?: (uploadId: string) => Response | Promise<Response>
}

/**
 * 模拟直传三段式 fetch:票据 → 七牛直传 → confirm。
 * 测试只关心「按契约发什么」,不连真实网络。
 */
function installDirectFlow(overrides: FlowOverrides = {}) {
  let ticketCount = 0
  const fetchMock = vi.fn(async (input: unknown, init?: { body?: unknown; headers?: Record<string, string> }) => {
    const url = String(input)
    if (url.endsWith('/uploads/tickets')) {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>
      ticketCount++
      if (overrides.ticket) return overrides.ticket(payload, ticketCount)
      return json({
        ok: true,
        upload_id: `up-${ticketCount}`,
        key: `sourcemaps/proj/${String(payload.original_name)}`,
        region: 'z0',
        token: 'qiniu-upload-token',
        expires_at: '2030-01-01T00:00:00Z',
      })
    }
    if (/^https:\/\/upload/.test(url)) {
      const form = init?.body as FormData
      if (overrides.qiniu) return overrides.qiniu(form)
      return json({ hash: 'h', key: String(form.get('key')) })
    }
    const matched = url.match(/\/uploads\/([^/]+)\/confirm$/)
    if (matched) {
      const uploadId = decodeURIComponent(matched[1])
      if (overrides.confirm) return overrides.confirm(uploadId)
      return json({ ok: true, upload_id: uploadId, business: 'sourcemaps', file_name: 'x', release: '1.2.3' })
    }
    throw new Error(`unexpected url: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function callsOf(fetchMock: ReturnType<typeof vi.fn>) {
  const urls = fetchMock.mock.calls.map((c) => String(c[0]))
  return {
    urls,
    tickets: urls.filter((u) => u.endsWith('/uploads/tickets')),
    qiniu: urls.filter((u) => /^https:\/\/upload/.test(u)),
    confirms: urls.filter((u) => /\/confirm$/.test(u)),
  }
}

async function run(plugin: ReturnType<typeof mooSourcemapUpload>, dir: string, bundle: Record<string, unknown>) {
  // writeBundle 在测试里直接调用(rollup 钩子签名:(outputOptions, bundle))
  await (plugin.writeBundle as (o: unknown, b: unknown) => Promise<void>)({ dir }, bundle)
}

const OPTS = { endpoint: 'https://cloud.test/api/v1/', token: 'moo_ci_token_12345', release: '1.2.3' }

describe('mooSourcemapUpload:直传七牛', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = installDirectFlow()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('只上传命中 include 的 .map,每个文件单独 ticket→七牛→confirm', async () => {
    const { dir, bundle } = await setupDist({
      'assets/index-abc.js.map': '{"version":3,"mappings":""}',
      'assets/index-abc.js': 'js code',
      'assets/style.css.map': '{}', // 默认 include 只收 .js.map
    })
    await run(mooSourcemapUpload({ ...OPTS, injectDebugIds: false }), dir, bundle)

    const calls = callsOf(fetchMock)
    expect(calls.tickets).toHaveLength(1)
    expect(calls.qiniu).toHaveLength(1)
    expect(calls.confirms).toHaveLength(1)

    const [ticketUrl, ticketInit] = fetchMock.mock.calls[0] as [string, { body: string; headers: Record<string, string> }]
    expect(ticketUrl).toBe('https://cloud.test/api/v1/uploads/tickets')
    expect(ticketInit.headers.Authorization).toBe('Bearer moo_ci_token_12345')
    const payload = JSON.parse(ticketInit.body) as Record<string, unknown>
    expect(payload.business).toBe('sourcemaps')
    expect(payload.release).toBe('1.2.3')
    expect(payload.original_name).toBe('index-abc.js.map') // 只取 basename
    expect(payload.file_size).toBe(Buffer.byteLength('{"version":3,"mappings":""}'))
    expect(String(payload.sha256)).toMatch(/^[0-9a-f]{64}$/)
    expect(String(payload.build_id)).toMatch(/^[0-9a-f]{32}$/)
    expect(payload.source_mode).toBe('context')

    const qiniuCall = fetchMock.mock.calls.find((c) => /^https:\/\/upload/.test(String(c[0]))) as [string, { body: FormData }]
    expect(qiniuCall[0]).toBe('https://upload.qiniup.com') // z0 无区域后缀
    const form = qiniuCall[1].body
    expect(form.get('token')).toBe('qiniu-upload-token')
    expect(form.get('key')).toBe('sourcemaps/proj/index-abc.js.map')
    const file = form.get('file') as File
    expect(file.name).toBe('index-abc.js.map')

    expect(calls.confirms[0]).toBe('https://cloud.test/api/v1/uploads/up-1/confirm')
    const confirmInit = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/confirm'))?.[1] as { headers: Record<string, string> }
    expect(confirmInit.headers.Authorization).toBe('Bearer moo_ci_token_12345')
  })

  it('多个 .map 逐个上传(不再 multipart 分块),同一构建共用一个 build_id', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 23; i++) files[`chunk-${i}.js.map`] = `{"i":${i}}`
    const { dir, bundle } = await setupDist(files)

    await run(mooSourcemapUpload({ ...OPTS, injectDebugIds: false }), dir, bundle)

    const calls = callsOf(fetchMock)
    expect(calls.tickets).toHaveLength(23)
    expect(calls.qiniu).toHaveLength(23)
    expect(calls.confirms).toHaveLength(23)
    const ids = calls.tickets.map((_, i) => {
      const call = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/uploads/tickets'))[i]
      return String((JSON.parse(String((call[1] as { body: string }).body)) as { build_id: string }).build_id)
    })
    expect(new Set(ids).size).toBe(1)
  })

  it('deleteAfterUpload:全部确认成功后从产物目录删除 .map', async () => {
    const { dir, bundle } = await setupDist({ 'a.js.map': '{}', 'a.js': 'code' })

    await run(mooSourcemapUpload({ ...OPTS, injectDebugIds: false, deleteAfterUpload: true }), dir, bundle)
    expect(await readdir(dir)).toEqual(['a.js']) // .map 已删,js 保留
  })

  it('archiveDir:按 release/app 目录归档 sourcemap 和 manifest', async () => {
    const { dir, bundle } = await setupDist({ 'assets/a.js.map': '{"version":3,"mappings":""}', 'assets/a.js': 'code' })
    const archive = await mkdtemp(join(tmpdir(), 'moo-sm-archive-'))

    await run(
      mooSourcemapUpload({ ...OPTS, injectDebugIds: false, app: 'admin/web', archiveDir: archive, deleteAfterUpload: true }),
      dir,
      bundle,
    )

    const target = join(archive, '1.2.3', 'admin_web')
    expect((await readdir(target)).sort()).toEqual(['a.js.map', 'manifest.json'])
    const manifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8')) as { release: string; app: string; files: string[] }
    expect(manifest.release).toBe('1.2.3')
    expect(manifest.app).toBe('admin/web')
    expect(manifest.files).toEqual(['a.js.map'])
  })

  it('sourceMode=position:上传前剥离 sourcesContent,ticket 带 position', async () => {
    const { dir, bundle } = await setupDist({
      'assets/a.js.map': JSON.stringify({ version: 3, sources: ['src/App.vue'], sourcesContent: ['secret source'], names: [], mappings: '' }),
      'assets/a.js': 'code',
    })

    await run(mooSourcemapUpload({ ...OPTS, sourceMode: 'position', injectDebugIds: false }), dir, bundle)

    expect(JSON.parse(await readFile(join(dir, 'assets/a.js.map'), 'utf8')).sourcesContent).toBeUndefined()
    const ticketCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/uploads/tickets')) as [string, { body: string }]
    expect((JSON.parse(ticketCall[1].body) as { source_mode: string }).source_mode).toBe('position')
    const qiniuCall = fetchMock.mock.calls.find((c) => /^https:\/\/upload/.test(String(c[0]))) as [string, { body: FormData }]
    const uploaded = qiniuCall[1].body.get('file') as File
    expect(await uploaded.text()).not.toContain('sourcesContent')
  })

  it('strict:每个文件都有 confirm 回执且全部成功,即使无 health 也通过(直传契约)', async () => {
    const { dir, bundle } = await setupDist({ 'a.js.map': '{}', 'b.js.map': '{}' })
    await expect(run(mooSourcemapUpload({ ...OPTS, injectDebugIds: false, strict: true }), dir, bundle)).resolves.toBeUndefined()
  })

  it('strict:单文件 confirm 被拒(422)时让构建失败', async () => {
    installDirectFlow({ confirm: () => json({ errors: { upload: '七牛对象大小或 SHA-256 与申请不一致。' } }, 422) })
    const { dir, bundle } = await setupDist({ 'a.js.map': '{}' })

    await expect(run(mooSourcemapUpload({ ...OPTS, injectDebugIds: false, strict: true }), dir, bundle)).rejects.toThrow(
      'strict check failed',
    )
  })

  it('strict:confirm 返回 health 时沿用原有健康校验(Debug ID 覆盖不足即失败)', async () => {
    installDirectFlow({
      confirm: () => json({
        ok: true,
        upload_id: 'up-1',
        business: 'sourcemaps',
        file_name: 'a',
        release: '1.2.3',
        health: { current_build_artifacts: 1, missing_files: 0, debug_id_coverage: 0.5, duplicate_debug_ids: 0 },
      }),
    })
    const { dir, bundle } = await setupDist({ 'a.js.map': '{}' })

    await expect(run(mooSourcemapUpload({ ...OPTS, injectDebugIds: false, strict: true }), dir, bundle)).rejects.toThrow('Debug ID 覆盖率')
  })

  it('strict:票据申请 HTTP 500 直接失败,不受 failOnError 默认值影响', async () => {
    installDirectFlow({ ticket: () => json({ message: 'Server Error' }, 500) })
    const { dir, bundle } = await setupDist({ 'a.js.map': '{}' })

    await expect(run(mooSourcemapUpload({ ...OPTS, injectDebugIds: false, strict: true }), dir, bundle)).rejects.toThrow('HTTP 500')
  })

  it('archiveDir 归档失败:默认只告警不挡构建,上传照常', async () => {
    const { dir, bundle } = await setupDist({ 'a.js.map': '{}' })
    const blocker = join(dir, 'archive-blocker')
    await writeFile(blocker, 'not a dir') // archiveDir 指向一个文件 → mkdir 失败

    await run(mooSourcemapUpload({ ...OPTS, injectDebugIds: false, archiveDir: blocker }), dir, bundle)

    expect(callsOf(fetchMock).tickets).toHaveLength(1)
    expect(vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes('归档 sourcemap 失败'))).toBe(true)
  })

  it('单文件 confirm 报错时:告警、不删 map;failOnError 才抛', async () => {
    installDirectFlow({ confirm: () => json({ errors: { upload: '对象校验失败' } }, 422) })
    const { dir, bundle } = await setupDist({ 'a.js.map': '{}' })

    await run(mooSourcemapUpload({ ...OPTS, injectDebugIds: false, deleteAfterUpload: true }), dir, bundle)
    expect(await readdir(dir)).toEqual(['a.js.map']) // 有失败 → 不删

    await expect(
      run(mooSourcemapUpload({ ...OPTS, injectDebugIds: false, failOnError: true }), dir, bundle),
    ).rejects.toThrow('被云端拒绝')
  })

  it('默认失败不挡构建(网络错 / 403 / 非 VIP 都只告警);failOnError=true 时抛错', async () => {
    const { dir, bundle } = await setupDist({ 'a.js.map': '{}' })

    installDirectFlow({ ticket: () => Promise.reject(new Error('ECONNREFUSED')) })
    await run(mooSourcemapUpload({ ...OPTS, injectDebugIds: false }), dir, bundle) // 不抛

    installDirectFlow({ ticket: () => json({ error: 'vip_required' }, 403) })
    await run(mooSourcemapUpload({ ...OPTS, injectDebugIds: false }), dir, bundle) // 不抛
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('VIP'))

    installDirectFlow({ ticket: () => json({ error: 'boom' }, 500) })
    await expect(run(mooSourcemapUpload({ ...OPTS, injectDebugIds: false, failOnError: true }), dir, bundle)).rejects.toThrow('HTTP 500')
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

describe('直传契约细节:429 / 未知区域 / 对象已存在', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('429 按 Retry-After 等待后重试一次成功', async () => {
    const fetchMock = installDirectFlow({
      ticket: (_payload, call) =>
        call === 1 ? json({ message: 'Too Many Attempts.' }, 429, { 'Retry-After': '0' }) : json({
          ok: true,
          upload_id: 'up-2',
          key: 'k',
          region: 'z0',
          token: 'qiniu-upload-token',
          expires_at: '2030-01-01T00:00:00Z',
        }),
    })
    const { dir, bundle } = await setupDist({ 'a.js.map': '{}' })
    await run(mooSourcemapUpload({ ...OPTS, injectDebugIds: false }), dir, bundle)

    expect(callsOf(fetchMock).tickets).toHaveLength(2)
    expect(callsOf(fetchMock).confirms).toHaveLength(1)
  })

  it('未知七牛区域:告警且不发起七牛请求', async () => {
    const fetchMock = installDirectFlow({
      ticket: () => json({ ok: true, upload_id: 'up-x', key: 'k', region: 'xx-1', token: 't', expires_at: 'x' }),
    })
    const { dir, bundle } = await setupDist({ 'a.js.map': '{}' })
    await run(mooSourcemapUpload({ ...OPTS, injectDebugIds: false }), dir, bundle)

    expect(callsOf(fetchMock).qiniu).toHaveLength(0)
    expect(vi.mocked(console.warn).mock.calls.map((c) => String(c[0])).join('\n')).toContain('未知七牛区域')
  })

  it('七牛返回 file exists(614)按已存在对象处理,仍继续 confirm', async () => {
    // Response 构造器只接受 2xx-5xx;真实七牛的 614 由代码按 status 或 body.error 双路识别。
    const fetchMock = installDirectFlow({ qiniu: () => json({ error: 'file exists' }, 400) })
    const { dir, bundle } = await setupDist({ 'a.js.map': '{}' })
    await run(mooSourcemapUpload({ ...OPTS, injectDebugIds: false }), dir, bundle)

    expect(callsOf(fetchMock).confirms).toHaveLength(1)
    expect(vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join('\n')).toContain('对象复用')
  })
})

// 源自第八轮审查回归(Vite 插件失败处理)。
describe('⑤ Vite 插件失败处理(直传)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })
  const OPTS = { endpoint: 'https://cloud.test/api/v1', token: 'ci_token_1234567890', release: '1.0.0' }

  async function setup(maps: Record<string, string>) {
    const dir = await mkdtemp(join(tmpdir(), 'moo-r8-'))
    const bundle: Record<string, unknown> = {}
    for (const [n, c] of Object.entries(maps)) {
      await writeFile(join(dir, n), c)
      bundle[n] = { type: 'asset' }
    }
    return { dir, bundle }
  }

  it('中途 fatal 给出半传摘要(已确认 N/共 M)', async () => {
    let n = 0
    const fetchMock = installDirectFlow({
      ticket: () => {
        n++
        if (n === 2) return json({ message: 'Server Error' }, 500)
        return json({ ok: true, upload_id: `up-${n}`, key: 'k', region: 'z0', token: 't', expires_at: 'x' })
      },
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const maps: Record<string, string> = {}
    for (let i = 0; i < 3; i++) maps[`c${i}.js.map`] = '{}'
    const { dir, bundle } = await setup(maps)
    await run(mooSourcemapUpload({ ...OPTS, injectDebugIds: false }), dir, bundle)

    const all = warnSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(all).toContain('已确认 1/3')
    expect(all).toContain('HTTP 500')
    expect(callsOf(fetchMock).tickets).toHaveLength(2)
    vi.restoreAllMocks()
  })
})

// 源自第九轮审查回归(删 map 后剥 sourceMappingURL 注释)。
describe('② Vite 插件:删 map 后剥 sourceMappingURL 注释', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })
  const OPTS = { endpoint: 'https://cloud.test/api/v1', token: 'ci_token_1234567890', release: '1.0.0', deleteAfterUpload: true }

  async function runPlugin(sourcemapSetting: boolean | 'hidden') {
    const dir = await mkdtemp(join(tmpdir(), 'moo-r9-'))
    await writeFile(join(dir, 'a.js'), 'console.log(1)\n//# sourceMappingURL=a.js.map\n')
    await writeFile(join(dir, 'a.js.map'), '{}')
    installDirectFlow()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const plugin = mooSourcemapUpload({ ...OPTS, injectDebugIds: false })
    ;(plugin.configResolved as (c: unknown) => void)({ build: { sourcemap: sourcemapSetting } })
    await (plugin.writeBundle as (o: unknown, b: unknown) => Promise<void>)({ dir }, { 'a.js.map': {}, 'a.js': {} })
    return dir
  }

  it("sourcemap:true → 删 map 同时剥掉 JS 尾部注释(不再 404);'hidden' 不动 JS", async () => {
    const dir = await runPlugin(true)
    expect(await readdir(dir)).toEqual(['a.js'])
    const js = await readFile(join(dir, 'a.js'), 'utf8')
    expect(js).not.toContain('sourceMappingURL') // 注释被剥
    expect(js).toContain('console.log(1)')
    vi.restoreAllMocks()

    const dir2 = await runPlugin('hidden')
    const js2 = await readFile(join(dir2, 'a.js'), 'utf8')
    expect(js2).toContain('sourceMappingURL') // hidden 下 JS 本就不该被碰(此处文件是手造的)
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
    await expect(resolveMooRelease({ cwd: dir, tagPrefix: 'v', fallbackToLatestTag: false, fallbackTag: 'local' })).resolves.toBe(
      `local-${commit}`,
    )
  })
})
