import { readFile, unlink } from 'node:fs/promises'
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
  /** 上传失败时让构建失败,默认 false(只告警,不挡发布) */
  failOnError?: boolean
  /** 静默成功日志(告警仍输出),默认 false */
  silent?: boolean
}

/** 单次请求最多文件数(与云端上限对齐,留余量)。 */
const MAX_FILES_PER_REQUEST = 20

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

  return {
    name: 'moo-monitor-vue:sourcemap-upload',
    apply: 'build',
    enforce: 'post',
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

      const url = opts.endpoint.replace(/\/+$/, '') + '/sourcemaps/intake'
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

      for (let i = 0; i < names.length; i += MAX_FILES_PER_REQUEST) {
        const chunk = names.slice(i, i + MAX_FILES_PER_REQUEST)
        const form = new FormData()
        form.append('token', opts.token)
        form.append('release', opts.release)
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

      log(`已上传 ${uploaded} 个 sourcemap(release ${opts.release}${unchanged ? `,${unchanged} 个未变更跳过` : ''})。`)
      if (fileErrors > 0 && opts.failOnError) {
        throw new Error(`[moo-sourcemap] ${fileErrors} 个文件被云端拒绝(原因见上方告警)。`)
      }
      if (opts.deleteAfterUpload && fileErrors === 0) {
        for (const name of names) {
          await unlink(join(dir, name)).catch(() => {})
        }
        log(`已从产物目录删除 ${names.length} 个 .map(不随站点发布)。`)
      }
    },
  }
}
