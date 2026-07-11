import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { Plugin } from 'vite'

const execFileAsync = promisify(execFile)

/**
 * Vite 插件:构建结束后把产物里的 .map 上传到 Moo Scaffold Cloud,
 * 云端用它把前端错误的压缩堆栈还原成源码位置(.vue 文件即出错组件)。VIP 专享。
 *
 * 凭证安全:token 必须是单独生成的、只含「sourcemaps」能力的 CI token ——
 * 绝不能复用 SDK init 用的前端错误 token(那枚会出现在浏览器 JS 里,人人可见)。
 */
export interface SourcemapUploadOptions {
  /** 云端 API 基址,与 SDK init 的 endpoint 相同,例:https://cloud.example.com/api/v1 */
  endpoint: string
  /** 只含 sourcemaps 能力的项目 token(CI 密钥,勿入仓库 / 勿用浏览器 token) */
  token: string
  /** 版本号 —— 必须与 SDK init 的 release 完全一致,否则匹配不上 */
  release: string
  /** 匹配要上传的产物文件,默认 /\.js\.map$/ */
  include?: RegExp
  /** 上传成功后从产物目录删除 .map(不随站点发布、不泄源码),默认 false;生产建议 true */
  deleteAfterUpload?: boolean
  /**
   * 多应用标识(monorepo 必填):admin/website 等多个 Vite 应用共用同一 release/token 上传时,
   * 各应用须声明不同 app,否则云端「构建集替换」会把彼此的工件互相清掉。单应用项目可不填。
   */
  app?: string
  /**
   * 给每个 bundle 注入 Debug ID(默认 true):产物与 map 内容级强绑定,云端按 ID 匹配,
   * 不再依赖「release 三处一致」与文件名 —— 传错批次会显式匹配失败而非错位还原。
   * 需 SDK ≥0.3.7(帧上报携带 debug_id)+ 云端配套;关掉则退回 release+文件名匹配。
   */
  injectDebugIds?: boolean
  /** 上传失败时让构建失败,默认 false(只告警,不挡发布) */
  failOnError?: boolean
  /** 静默成功日志(告警仍输出),默认 false */
  silent?: boolean
  /**
   * 可选:上传前把 sourcemap 归档到本地目录,路径为 archiveDir/release/app。
   * 适合 CI 另存构建工件;归档后仍可 deleteAfterUpload 删除 dist 里的 .map。
   */
  archiveDir?: string
  /** 源码安全模式:context=保留 sourcesContent 供云端展示源码上下文;position=剥掉源码,仅还原文件/行/列。默认 context。 */
  sourceMode?: 'context' | 'position'
  /**
   * CI 强约束:上传后检查云端 health。true = 要求文件数齐、Debug ID 覆盖 100%、无重复 ID。
   * 不受 failOnError 影响:健康不达标、上传中断、配置缺失、云端未返回 health(版本过旧)
   * 都直接让构建失败 —— strict 的语义是「构建通过 = map 一定可用」,任何静默放行都是假保证。
   */
  strict?: boolean | { requireAllFiles?: boolean; requireDebugIds?: boolean; allowDuplicateDebugIds?: boolean }
}

export interface MooReleaseOptions {
  /** Git 工作目录,默认 process.cwd()。 */
  cwd?: string
  /** 只匹配指定前缀的 tag,例 'v' → v1.2.3。默认不限。 */
  tagPrefix?: string
  /** 找不到 tag 时使用的前缀,默认 'untagged'。 */
  fallbackTag?: string
  /** describe 找不到可达 tag 时,允许退回到本地最新 tag。浅克隆 CI 推荐开启,默认 true。 */
  fallbackToLatestTag?: boolean
  /** 生成前先 git fetch <remote> --tags --force。CI 浅克隆且依赖远程 tags 时开启。 */
  fetchTags?: boolean
  /** fetchTags 使用的远程名,默认 'origin'。 */
  remote?: string
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return String(stdout).trim()
}

/**
 * 从当前 Git 版本生成 sourcemap release,格式为 [tag]-[8位commit hash]。
 *
 * 推荐在 vite.config.ts 里先 await 一次,同一个值同时用于:
 *   1. define 注入给浏览器 SDK init({ release });
 *   2. mooSourcemapUpload({ release }) 上传 map。
 */
export async function resolveMooRelease(options: MooReleaseOptions = {}): Promise<string> {
  const cwd = options.cwd ?? process.cwd()
  if (options.fetchTags) {
    await git(['fetch', options.remote ?? 'origin', '--tags', '--force'], cwd)
  }

  const pattern = options.tagPrefix ? `${options.tagPrefix}*` : '*'
  const commit = await git(['rev-parse', '--short=8', 'HEAD'], cwd)
  let tag = await git(['describe', '--tags', '--abbrev=0', '--match', pattern], cwd).catch(() => '')
  if (!tag && options.fallbackToLatestTag !== false) {
    tag = await git(['tag', '--list', pattern, '--sort=-creatordate'], cwd)
      .then((out) => out.split('\n').find(Boolean) ?? '')
      .catch(() => '')
  }
  if (!tag) tag = options.fallbackTag ?? 'untagged'

  return `${tag}-${commit}`
}

/** 单次请求最多文件数(与云端上限对齐,留余量;也勿超 PHP max_file_uploads 默认 20)。 */
const MAX_FILES_PER_REQUEST = 20

/** 单次请求累计字节上限:保守低于服务器 post_max_size 的常见默认(8M)。 */
const MAX_REQUEST_BYTES = 6 * 1024 * 1024

/** js 内容 sha256 → 确定性 uuid 形态的 debug id(同一构建产物永远同 ID,watch 重跑不漂移)。 */
function deriveDebugId(jsContent: string): string {
  const h = createHash('sha256').update(jsContent).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

function safePathSegment(value: string): string {
  return value.replace(/[\\/:*?"<>|]+/g, '_')
}

/**
 * 给一对 (js, map) 注入 Debug ID:
 *  - js 头部加一行注册 snippet(运行时以 new Error().stack 为键存 ID —— 栈里带着该 chunk
 *    被浏览器实际加载的 URL,SDK 据此建 file→id 映射,与部署路径/文件名解耦);
 *  - map.mappings 前补一个 ';'(补偿头部新增的一行,否则全部行号偏移 1);
 *  - js 尾部加 //# debugId= 注释(置于 sourceMappingURL 注释之前)+ map 写 debug_id 字段。
 * 幂等:map 已有 debug_id 则跳过(watch 增量场景)。返回是否实际注入。
 */
async function injectDebugId(dir: string, mapName: string): Promise<boolean> {
  const jsPath = join(dir, mapName.replace(/\.map$/, ''))
  const mapPath = join(dir, mapName)
  const [js, mapRaw] = await Promise.all([readFile(jsPath, 'utf8'), readFile(mapPath, 'utf8')])
  const map = JSON.parse(mapRaw) as { debug_id?: string; mappings?: string }
  if (map.debug_id) return false

  const id = deriveDebugId(js)
  map.debug_id = id
  map.mappings = ';' + (map.mappings || '')

  const snippet = `;!function(){try{var e=new Error().stack;e&&(window._mooDebugIds=window._mooDebugIds||{},window._mooDebugIds[e]="${id}")}catch(r){}}();\n`
  const idComment = `//# debugId=${id}`
  let out = snippet + js
  out = out.includes('//# sourceMappingURL=')
    ? out.replace('//# sourceMappingURL=', `${idComment}\n//# sourceMappingURL=`)
    : out + (out.endsWith('\n') ? '' : '\n') + idComment + '\n'

  await Promise.all([writeFile(jsPath, out), writeFile(mapPath, JSON.stringify(map))])
  return true
}

async function stripSourcesContent(dir: string, mapName: string): Promise<boolean> {
  const mapPath = join(dir, mapName)
  const raw = await readFile(mapPath, 'utf8')
  const map = JSON.parse(raw) as { sourcesContent?: unknown }
  if (!('sourcesContent' in map)) return false
  delete map.sourcesContent
  await writeFile(mapPath, JSON.stringify(map))
  return true
}

export function mooSourcemapUpload(opts: SourcemapUploadOptions): Plugin {
  const include = opts.include ?? /\.js\.map$/
  const log = (m: string) => {
    if (!opts.silent) console.log(`[moo-sourcemap] ${m}`)
  }
  const warn = (m: string) => console.warn(`[moo-sourcemap] ⚠ ${m}`)
  // 失败策略集中一处:failOnError / strict 时抛错挡构建,否则告警放行。
  // strict 也走硬失败:上传中断、配置缺失若只告警,「CI 保证 map 可用」就是假的。
  const fail = (m: string) => {
    if (opts.failOnError || opts.strict) throw new Error(`[moo-sourcemap] ${m}`)
    warn(m)
  }

  // build.sourcemap 的最终取值(configResolved 里拿):true 时产物 JS 带指向注释,
  // deleteAfterUpload 删 map 后须把注释一并剥掉,否则全量访客的 devtools 每 chunk 一个 404。
  let sourcemapSetting: boolean | 'inline' | 'hidden' | undefined
  // 多 output 构建(@vitejs/plugin-legacy 等)会对同一插件实例多次调 writeBundle,各 output 的 buildId 不同。
  // 记录首个 buildId,二次不同即告警(P3.5)——否则第二个 output 以不同 build_id 触发云端「构建集替换」,
  // 把前一个 output 的 map 整组清掉,且 strict 查不出来(expected_files 按本 output 计)。
  let firstBuildId: string | undefined

  return {
    name: 'moo-monitor-vue:sourcemap-upload',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      sourcemapSetting = config.build?.sourcemap as boolean | 'inline' | 'hidden' | undefined
    },
    async writeBundle(output, bundle) {
      if (!opts.endpoint || !opts.token || !opts.release) {
        fail('endpoint / token / release 均必填,已跳过 sourcemap 上传。')
        return
      }
      const dir = output.dir
      if (!dir) {
        fail('未找到输出目录(仅支持 dir 模式构建),已跳过上传。')
        return
      }
      const names = Object.keys(bundle).filter((n) => include.test(n))
      if (names.length === 0) {
        fail("未发现 .map 产物 —— 请确认 build.sourcemap 已开启(推荐 'hidden':生成 map 但产物里不留指向注释)。")
        return
      }

      // basename 冲突检测(P3.6,不改行为):上传(files[])与归档都只按 basename 处理,自定义 entryFileNames
      // 产出不同目录同名 map 时归档互相覆盖、云端匹配二义(debug_id 能救栈匹配,救不了归档丢失)。命中即告警。
      {
        const byBase = new Map<string, string[]>()
        for (const n of names) {
          const b = basename(n)
          const arr = byBase.get(b)
          if (arr) arr.push(n)
          else byBase.set(b, [n])
        }
        for (const [b, group] of byBase) {
          if (group.length > 1) {
            warn(`不同目录下存在同名 map「${b}」(${group.join(', ')})—— 上传/归档只按 basename 处理,会互相覆盖、云端匹配二义;请避免跨目录重名产物或用 include 收窄。`)
          }
        }
      }

      // Debug ID 注入(上传前):产物与 map 内容级强绑定,云端优先按 ID 匹配。
      if (opts.injectDebugIds !== false) {
        let injected = 0
        for (const mapName of names) {
          try {
            injected += (await injectDebugId(dir, mapName)) ? 1 : 0
          } catch (e) {
            warn(`debug id 注入失败(${mapName}):${e instanceof Error ? e.message : String(e)} —— 该文件退回文件名匹配。`)
          }
        }
        if (injected > 0) log(`已为 ${injected} 个 bundle 注入 debug id。`)
      }
      if (opts.sourceMode === 'position') {
        let stripped = 0
        for (const mapName of names) {
          try {
            stripped += (await stripSourcesContent(dir, mapName)) ? 1 : 0
          } catch (e) {
            warn(`剥离 sourcesContent 失败(${mapName}):${e instanceof Error ? e.message : String(e)}。`)
          }
        }
        if (stripped > 0) log(`已从 ${stripped} 个 sourcemap 剥离 sourcesContent(仅位置还原模式)。`)
      }

      const url = opts.endpoint.replace(/\/+$/, '') + '/sourcemaps/intake'
      // 构建集标识(确定性):全部 map 文件名排序后哈希 —— Vite 产物名带内容 hash,
      // 名单即构建内容。云端按它做「构建集替换」:同 release 重复构建时旧工件整组清掉
      // (否则每次构建全部改名,旧 map 无限堆积、占满 release 配额);同一构建的分块/
      // 断点补传/CI 重跑同内容则相安无事。
      const buildId = createHash('sha256').update([...names].sort().join('\n')).digest('hex').slice(0, 32)
      // 多 output 互清构建集告警(P3.5,不改行为):同进程二次 writeBundle 且 buildId 不同 → 提示按 output 区分 app。
      if (firstBuildId === undefined) {
        firstBuildId = buildId
      } else if (firstBuildId !== buildId) {
        warn(
          '同一进程内多次 writeBundle 且 build_id 不同(典型:@vitejs/plugin-legacy 等多 output 构建)—— ' +
            '各 output 会以不同 build_id 触发云端「构建集替换」,可能把彼此的 map 整组清掉。' +
            '请为每个 output 传入不同的 app 参数加以区分(见 README「多 output / 多应用构建」一节)。',
        )
      }
      if (opts.archiveDir) {
        // 归档失败不该无条件炸构建(与上传失败同一策略:默认告警,failOnError/strict 才硬失败)。
        try {
          const archivePath = join(opts.archiveDir, safePathSegment(opts.release), safePathSegment(opts.app ?? 'default'))
          await mkdir(archivePath, { recursive: true })
          await Promise.all(names.map((name) => copyFile(join(dir, name), join(archivePath, basename(name)))))
          await writeFile(
            join(archivePath, 'manifest.json'),
            JSON.stringify(
              {
                release: opts.release,
                app: opts.app ?? null,
                build_id: buildId,
                files: [...names].sort().map((name) => basename(name)),
                created_at: new Date().toISOString(),
              },
              null,
              2,
            ),
          )
          log(`已归档 ${names.length} 个 sourcemap 到 ${archivePath}。`)
        } catch (e) {
          fail(`归档 sourcemap 失败(${opts.archiveDir}):${e instanceof Error ? e.message : String(e)}。`)
        }
      }
      // 分块同时受「条数 ≤20」与「累计 ≤6MB」约束:只按条数的话,20 个大 map 一个请求可达
      // 数十 MB,超过服务器 post_max_size(常见默认 8M)时整个 POST 被 PHP 丢弃 ——
      // Laravel 连 token 都读不到,报出来的是误导性的 401。
      const sizes = new Map<string, number>()
      for (const n of names) {
        try {
          sizes.set(n, (await stat(join(dir, n))).size)
        } catch {
          sizes.set(n, 0)
        }
      }
      const chunks: string[][] = []
      {
        let cur: string[] = []
        let curBytes = 0
        for (const n of names) {
          const sz = sizes.get(n) ?? 0
          if (cur.length > 0 && (cur.length >= MAX_FILES_PER_REQUEST || curBytes + sz > MAX_REQUEST_BYTES)) {
            chunks.push(cur)
            cur = []
            curBytes = 0
          }
          cur.push(n)
          curBytes += sz
        }
        if (cur.length) chunks.push(cur)
      }
      let uploaded = 0
      let unchanged = 0
      let fileErrors = 0
      let sentFiles = 0
      type IntakeHealth = {
        current_build_artifacts?: number
        missing_files?: number | null
        debug_id_coverage?: number | null
        duplicate_debug_ids?: number
        ok?: boolean
      }
      let lastHealth: IntakeHealth | undefined
      type IntakeBody = { saved?: number; skipped?: number; errors?: Record<string, string>; error?: string; message?: string; health?: IntakeHealth } | null
      const postChunk = async (form: FormData) => {
        const res = await fetch(url, { method: 'POST', body: form })
        const body = (await res.json().catch(() => null)) as IntakeBody
        return { res, body }
      }
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
      // 中途失败时给出半传摘要:release 只传了一部分也是种状态,不能只留一句裸告警。
      const abort = (reason: string) => {
        fail(`${reason}(已传 ${sentFiles}/${names.length} 个文件,release ${opts.release} 处于部分上传状态,重跑构建可补齐)`)
      }

      for (const chunk of chunks) {
        const form = new FormData()
        form.append('token', opts.token)
        form.append('release', opts.release)
        form.append('build_id', buildId)
        form.append('expected_files', String(names.length))
        form.append('source_mode', opts.sourceMode ?? 'context')
        if (opts.app) form.append('app', opts.app)
        for (const name of chunk) {
          const buf = await readFile(join(dir, name))
          // 文件名只取 basename:云端用「去 .map 后的产物名」匹配错误栈帧里的文件
          form.append('files[]', new Blob([buf], { type: 'application/json' }), basename(name))
        }

        let outcome: { res: Response; body: IntakeBody }
        try {
          outcome = await postChunk(form)
          if (outcome.res.status === 429) {
            // 撞云端限流:等 2s 重试一次(CI 里多 chunk 连发偶发),再失败才放弃。
            await sleep(2000)
            outcome = await postChunk(form)
          }
        } catch (e) {
          abort(`上传请求失败(网络/地址问题):${e instanceof Error ? e.message : String(e)}`)
          return
        }
        const { res, body } = outcome
        // Laravel 框架级错误(429 限流/异常页)的提示在 message 字段,业务错误在 error 字段 —— 都认。
        const errText = body?.error || body?.message

        if (res.status === 403 && body?.error === 'vip_required') {
          fail('sourcemap 还原为 VIP 功能 —— 请项目拥有者开通会员后再传(本次构建不受影响)。')
          return
        }
        if (res.status === 413) {
          abort('上传失败:HTTP 413(请求体超过服务器上传限制)—— 请将服务端 PHP 的 post_max_size / upload_max_filesize 调到 ≥20M')
          return
        }
        if (!res.ok) {
          abort(`上传失败:HTTP ${res.status}${errText ? ` — ${errText}` : ''}`)
          return
        }
        sentFiles += chunk.length
        uploaded += body?.saved ?? 0
        unchanged += body?.skipped ?? 0
        lastHealth = body?.health
        for (const [file, reason] of Object.entries(body?.errors ?? {})) {
          fileErrors++
          warn(`${file}: ${reason}`)
        }
      }

      if (opts.strict && !lastHealth) {
        // 云端版本过旧(响应无 health 字段)时静默放行 = CI 以为有保护、实际没有。
        throw new Error('[moo-sourcemap] strict 已开启但云端未返回 health(云端版本过旧或响应异常),无法验证上传结果 —— 请升级云端,或暂时关闭 strict。')
      }
      if (opts.strict && lastHealth) {
        const strict = opts.strict === true ? {} : opts.strict
        const requireAllFiles = strict?.requireAllFiles ?? true
        const requireDebugIds = strict?.requireDebugIds ?? true
        const allowDuplicateDebugIds = strict?.allowDuplicateDebugIds ?? false
        const failures: string[] = []
        if (requireAllFiles && (lastHealth.missing_files ?? 0) > 0) failures.push(`缺少 ${lastHealth.missing_files} 个文件`)
        if (requireAllFiles && (lastHealth.current_build_artifacts ?? 0) < names.length) failures.push(`云端当前构建只有 ${lastHealth.current_build_artifacts ?? 0}/${names.length} 个文件`)
        if (requireDebugIds && lastHealth.debug_id_coverage !== 1) failures.push(`Debug ID 覆盖率 ${Math.round((lastHealth.debug_id_coverage ?? 0) * 100)}%`)
        if (!allowDuplicateDebugIds && (lastHealth.duplicate_debug_ids ?? 0) > 0) failures.push(`重复 Debug ID ${lastHealth.duplicate_debug_ids} 个`)
        if (uploaded + unchanged + fileErrors !== names.length) failures.push(`上传回执数量不一致:${uploaded}+${unchanged}+${fileErrors}/${names.length}`)
        if (failures.length) {
          throw new Error(`[moo-sourcemap] sourcemap strict check failed:${failures.join('; ')}`)
        }
      }

      log(
        `已上传 ${uploaded} 个 sourcemap(release ${opts.release}${unchanged ? `,${unchanged} 个未变更跳过` : ''})。` +
          (uploaded > 0 ? '云端还原约 2 分钟后生效(防抖收尾 + 队列消费),刚上报的错误稍后刷新即可看到源码位置。' : ''),
      )
      if (fileErrors > 0 && opts.failOnError) {
        throw new Error(`[moo-sourcemap] ${fileErrors} 个文件被云端拒绝(原因见上方告警)。`)
      }
      if (opts.deleteAfterUpload && fileErrors > 0) {
        // 有文件被拒时跳过删除要说清:用户明确要求不发布 .map,静默保留等于背着他发布了源码。
        warn(`${fileErrors} 个文件被云端拒绝 → 本次未删除任何 .map(产物目录里仍有源码,修复后重跑构建)。`)
      }
      if (opts.deleteAfterUpload && fileErrors === 0) {
        for (const name of names) {
          await unlink(join(dir, name)).catch(() => {})
          // sourcemap:true 时产物 JS 尾部留着 //# sourceMappingURL= 注释,map 删了注释还在
          // → 每个开 devtools 的访客每 chunk 一个 404。剥掉注释(等效 'hidden')。
          if (sourcemapSetting === true) {
            const jsPath = join(dir, name.replace(/\.map$/, ''))
            try {
              const code = await readFile(jsPath, 'utf8')
              const stripped = code.replace(/\n?\/\/# sourceMappingURL=[^\n]*\s*$/, '\n')
              if (stripped !== code) await writeFile(jsPath, stripped)
            } catch {
              /* 对应 JS 不在(异名/已被其他插件处理):跳过即可 */
            }
          }
        }
        log(
          `已从产物目录删除 ${names.length} 个 .map(不随站点发布)。` +
            (sourcemapSetting === true ? '已同步剥离 JS 尾部的 sourceMappingURL 注释(建议直接配 sourcemap:"hidden")。' : ''),
        )
      }
    },
  }
}
