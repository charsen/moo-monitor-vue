import { createHash } from 'node:crypto'
import { readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Plugin } from 'vite'

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

export function mooSourcemapUpload(opts: SourcemapUploadOptions): Plugin {
  const include = opts.include ?? /\.js\.map$/
  const log = (m: string) => {
    if (!opts.silent) console.log(`[moo-sourcemap] ${m}`)
  }
  const warn = (m: string) => console.warn(`[moo-sourcemap] ⚠ ${m}`)
  // 失败策略集中一处:failOnError 时抛错挡构建,否则告警放行。
  const fail = (m: string) => {
    if (opts.failOnError) throw new Error(`[moo-sourcemap] ${m}`)
    warn(m)
  }

  // build.sourcemap 的最终取值(configResolved 里拿):true 时产物 JS 带指向注释,
  // deleteAfterUpload 删 map 后须把注释一并剥掉,否则全量访客的 devtools 每 chunk 一个 404。
  let sourcemapSetting: boolean | 'inline' | 'hidden' | undefined

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

      const url = opts.endpoint.replace(/\/+$/, '') + '/sourcemaps/intake'
      // 构建集标识(确定性):全部 map 文件名排序后哈希 —— Vite 产物名带内容 hash,
      // 名单即构建内容。云端按它做「构建集替换」:同 release 重复构建时旧工件整组清掉
      // (否则每次构建全部改名,旧 map 无限堆积、占满 release 配额);同一构建的分块/
      // 断点补传/CI 重跑同内容则相安无事。
      const buildId = createHash('sha256').update([...names].sort().join('\n')).digest('hex').slice(0, 32)
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
      type IntakeBody = { saved?: number; skipped?: number; errors?: Record<string, string>; error?: string; message?: string } | null
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
        for (const [file, reason] of Object.entries(body?.errors ?? {})) {
          fileErrors++
          warn(`${file}: ${reason}`)
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
