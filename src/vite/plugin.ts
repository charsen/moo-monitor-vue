import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { Plugin } from 'vite'
import {
  computeBuildId,
  SourcemapUploadError,
  uploadSourcemapFile,
  type SourcemapHealth,
  type SourcemapSourceMode,
} from './directUpload'

const execFileAsync = promisify(execFile)

/**
 * Vite 插件:构建结束后把产物里的 .map 经「云端签票据 → 直传七牛 → confirm」上传,
 * 云端再用它把前端错误的压缩堆栈还原成源码位置(.vue 文件即出错组件)。VIP 专享。
 *
 * 凭证安全:token 必须是单独生成的、只含「sourcemaps」能力的 CI token ——
 * 绝不能复用 SDK init 用的前端错误 token(那枚会出现在浏览器 JS 里,人人可见)。
 */
export interface SourcemapUploadOptions {
  /** 云端 API 基址,与 SDK init 的 endpoint 相同,例:https://cloud.example.com/api/v1 */
  endpoint: string
  /** 只含 sourcemaps 能力的项目 token(CI 密钥,勿入仓库 / 勿用浏览器 token) */
  token: string
  /** 版本号。建议与 SDK init 同源生成;关闭 Debug ID 或老接入时必须完全一致。 */
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
   * CI 强约束:每个文件都必须完成 ticket → 直传七牛 → confirm。true = 全部文件确认成功;
   * 服务端 confirm 若附带 health,再校验文件数齐、Debug ID 覆盖 100%、无重复 ID。
   * 不受 failOnError 影响:配置缺失、任一文件失败、health 不达标都直接让构建失败 ——
   * strict 的语义是「构建通过 = map 一定可用」,任何静默放行都是假保证。
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

      // 构建集标识(确定性):全部 map 文件名排序后哈希 —— Vite 产物名带内容 hash,
      // 名单即构建内容。直传流按文件分别登记,每个 ticket 都必须带同一个 build_id,
      // 服务端才能把同一次构建的工件归入一个构建集(用于整组替换/清理)。
      const buildId = computeBuildId(names)
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
      // 直传契约:云端只签票据与核验,每个 .map 单独走「ticket → 七牛直传 → confirm」。
      // 不再把文件打进 multipart POST:cloud 端不再接收 .map 本体,也绕开 PHP post_max_size。
      let uploaded = 0
      let reused = 0
      let fileErrors = 0
      let lastHealth: SourcemapHealth | undefined
      // 中途 fatal 时给出半传摘要:release 只传了一部分也是种状态,不能只留一句裸告警。
      const abort = (reason: string) => {
        fail(`${reason}(已确认 ${uploaded}/${names.length} 个文件,release ${opts.release} 处于部分上传状态,重跑构建可补齐)`)
      }

      for (const name of names) {
        const file = basename(name)
        let bytes: Buffer
        try {
          bytes = await readFile(join(dir, name))
        } catch (e) {
          abort(`读取 sourcemap 失败(${file}):${e instanceof Error ? e.message : String(e)}`)
          return
        }

        try {
          const result = await uploadSourcemapFile(
            { endpoint: opts.endpoint, token: opts.token },
            {
              release: opts.release,
              app: opts.app,
              buildId,
              sourceMode: (opts.sourceMode ?? 'context') as SourcemapSourceMode,
            },
            file,
            bytes,
          )
          uploaded++
          if (result.reusedObject) reused++
          if (result.health) lastHealth = result.health
        } catch (e) {
          const err =
            e instanceof SourcemapUploadError
              ? e
              : new SourcemapUploadError(e instanceof Error ? e.message : String(e), 'fatal')
          // 单文件被云端拒绝(如 confirm 复核大小/SHA 不一致):继续传其余文件,最后按策略决定是否失败。
          if (err.kind === 'rejected') {
            fileErrors++
            warn(`${file}: ${err.message}`)
            continue
          }
          if (/vip_required/.test(err.message)) {
            fail('sourcemap 还原为 VIP 功能 —— 请项目拥有者开通会员后再传(本次构建不受影响)。')
            return
          }
          abort(`上传失败(${file}):${err.message}`)
          return
        }
      }

      if (opts.strict) {
        const strict = opts.strict === true ? {} : opts.strict
        const requireAllFiles = strict?.requireAllFiles ?? true
        const requireDebugIds = strict?.requireDebugIds ?? true
        const allowDuplicateDebugIds = strict?.allowDuplicateDebugIds ?? false
        const failures: string[] = []
        // 直传流程每个文件都有独立 confirm 回执(云端已回查七牛对象大小/SHA);数量不齐即失败。
        if (uploaded + fileErrors !== names.length) failures.push(`文件回执数量不一致:${uploaded}+${fileErrors}/${names.length}`)
        if (requireAllFiles && uploaded < names.length) failures.push(`仅 ${uploaded}/${names.length} 个文件直传并确认成功`)
        // 新直传契约的 confirm 不强制返回 health;服务端若返回则沿用原有 health 校验语义,
        // 不返回时以逐文件 confirm 作为「map 可用」的强校验(不再因缺少 health 直接判失败)。
        if (lastHealth) {
          if (requireAllFiles && (lastHealth.missing_files ?? 0) > 0) failures.push(`缺少 ${lastHealth.missing_files} 个文件`)
          if (requireAllFiles && (lastHealth.current_build_artifacts ?? 0) < names.length) failures.push(`云端当前构建只有 ${lastHealth.current_build_artifacts ?? 0}/${names.length} 个文件`)
          if (requireDebugIds && lastHealth.debug_id_coverage !== 1) failures.push(`Debug ID 覆盖率 ${Math.round((lastHealth.debug_id_coverage ?? 0) * 100)}%`)
          if (!allowDuplicateDebugIds && (lastHealth.duplicate_debug_ids ?? 0) > 0) failures.push(`重复 Debug ID ${lastHealth.duplicate_debug_ids} 个`)
        }
        if (failures.length) {
          throw new Error(`[moo-sourcemap] sourcemap strict check failed:${failures.join('; ')}`)
        }
      }

      log(
        `已上传 ${uploaded} 个 sourcemap(release ${opts.release}${reused ? `,${reused} 个已存在对象复用` : ''})。` +
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
