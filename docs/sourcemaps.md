---
title: Sourcemap 还原接入与排查
group: 前端监控
order: 20
---
# sourcemap 还原 —— 接入与排查

> 适用:moo-monitor-vue ≥ 0.3.0 + moo-scaffold-cloud(含 `/api/v1/uploads/tickets` 与 `/api/v1/uploads/{upload_id}/confirm`)。**VIP 专享**(按项目拥有者会员判定)。
> 自本版起 sourcemap 上传改为**云端签票据 + 直传七牛 + confirm**,`.map` 字节不再经过云端。

## 原理一页纸

```
CI 构建(vite build, sourcemap: 'hidden')
  └─ mooSourcemapUpload 插件:收集 dist/**/*.js.map
       └─ 对每个 .map 单独走三步(云端不接收 .map 本体):
            ① POST /api/v1/uploads/tickets   Bearer sourcemaps token
               { business:'sourcemaps', release, original_name, file_size, sha256, app?, build_id?, source_mode? }
               → { upload_id, key, region, token, expires_at }
            ② POST https://upload[-<region>].qiniup.com   multipart token/key/file
               (字节只从构建机直达七牛)
            ③ POST /api/v1/uploads/{upload_id}/confirm   Bearer, {}
               (云端回查七牛对象大小 + SHA-256,登记 release_artifacts)

浏览器报错 → SDK 上报 frames(压缩位置 file:line:column + debug_id)+ release
  └─ 云端 intake 后异步任务(或打开详情时兜底)按【三级匹配链】找 map:
       ① debug_id 直查(插件注入,内容级强绑定,与 release/文件名/路径解耦)
       ② (release, 产物 basename) 精确(老 SDK / 未注入 ID 的 map)
       ③ basename 项目内唯一回退(Vite 产物名自带内容 hash,release 配错也能救;
          同名不同内容绝不瞎猜)
     → 流式 VLQ 解析 → 还原成源码 file:line:column(+ 函数名)
       └─ 还原位置之外,再从 map 内嵌的 sourcesContent 抽出错行 ±3 行源码
          (前 5 个还原帧,逐行截断 + 密钥脱敏后才入库)
  └─ 生效处:详情抽屉「调用栈」(每帧可展开源码、出错行高亮)/
     「复制给 AI 修复」markdown(位置 + 出错源码块)/ 列表摘要(出错组件,如 Foo.vue)
```

- **还原结果缓存在错误记录上**(`src_frames`),不会每次打开都重算;同 release 重新上传 map 会自动重置缓存、触发重算。
- **错误先到、map 后到没关系**:上传完成后该 release 的存量错误会重新还原。
- 还原不出的帧(vendor 没传 map、`native`/`eval` 帧、map 里无映射区间)原样显示压缩位置,不影响其他帧。

## 接入清单

1. **token**:`/app → 接入 Token → 生成`,只勾 **「Sourcemap 上传」**,存进 CI 的 secret(如 `MOO_SOURCEMAP_TOKEN`)。
   - ⚠️ 不要复用浏览器里的 `frontend_errors` token:那枚是公开的,复用 = 任何人都能灌/覆盖你的 map。
2. **release 生成**:推荐按远程 tag + 当前提交生成,格式为 `[tag]-[8位commit]`,例如 `v1.4.0-a1b2c3d4`。
   - CI 浅克隆时先 `git fetch origin --tags --force`,或用 `resolveMooRelease({ fetchTags: true })`;
   - `git describe` 找不到可达 tag 时会退回本地最新 tag;如要严格只接受可达 tag,传 `fallbackToLatestTag: false`;
   - shell/非 Vite 项目可用 `npx moo-monitor-release --fetch-tags --tag-prefix v` 输出同一规则的 release;
   - 当前提交还没打 tag 时,取最近可达 tag + 当前 commit,能明确表达“基于哪个发布线构建”;
   - 找不到 tag 时默认 `untagged-[commit]`,可用 `fallbackTag` 改成项目自己的前缀。
3. **vite.config.ts**:`build.sourcemap: 'hidden'` + `resolveMooRelease()` + `mooSourcemapUpload({ endpoint, token, release, deleteAfterUpload: true })`。
   - ⚠️ `endpoint` 只填基址(如 `https://cloud.example.com/api/v1`),**与 SDK init 的 endpoint 同值原样照抄**,
     插件内部自动拼 `/uploads/tickets` 与 `/uploads/{upload_id}/confirm`(少 `/api/v1` 或填成业务站域名都会 404);
   - 大型多入口项目 map 很多时,可用 `include` 只传业务入口:`include: /assets\/(index|admin)-.*\.js\.map$/`。
     该选项只减少上传文件数;Rollup 仍会先为全部 chunk 生成 map,因此不能用它估算或承诺构建峰值下降。
   - 生产 CI 建议开启 `strict: true`:每个文件都必须直传并 confirm 成功;云端在 confirm 回执里返回 `health` 时再校验文件齐/Debug ID/重复 ID。
   - 不希望源码上下文上云时设 `sourceMode: 'position'`,插件在上传前剥离 `sourcesContent`,仍可还原文件/行/列,但详情和 AI 修复不会展示源码片段。
   - 非 Vite 项目、补传或独立 CI 步骤可用手动脚本:`npx moo-monitor-sourcemap --dir dist --release "$APP_VERSION" --strict`(逐个 `.map` 走同一契约)。
4. **release 统一生成**(推荐;未注入 Debug ID 或老接入时是硬约束):
   - Vite `define: { __MOO_RELEASE__: JSON.stringify(release) }`;
   - SDK `init({ release: __MOO_RELEASE__ })`;
   - 插件 `mooSourcemapUpload({ release })`。
5. 发版后到 `/app → 设置 → Sourcemap` 确认工件已出现在对应 release 分组下。

## 推荐 Vite 配置

```ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { mooSourcemapUpload, resolveMooRelease } from 'moo-monitor-vue/vite'

const release = await resolveMooRelease({
  fetchTags: process.env.CI === 'true',
  tagPrefix: 'v',
})

export default defineConfig({
  build: { sourcemap: 'hidden' },
  define: {
    __MOO_RELEASE__: JSON.stringify(release),
  },
  plugins: [
    vue(),
    mooSourcemapUpload({
      endpoint: 'https://cloud.example.com/api/v1',
      token: process.env.MOO_SOURCEMAP_TOKEN!,
      release,
      sourceMode: 'context',
      strict: true,
      archiveDir: '.moo-sourcemaps',
      deleteAfterUpload: true,
    }),
  ],
})
```

SDK 初始化:

```ts
app.use(MooMonitor, {
  endpoint: 'https://cloud.example.com/api/v1',
  token: import.meta.env.VITE_MOO_TOKEN,
  release: __MOO_RELEASE__,
  releaseCheck: import.meta.env.DEV || import.meta.env.MODE === 'staging',
  onError: (err) => console.warn('[moo-monitor]', err), // releaseCheck 通过 onError 返回异常;默认静默
})
```

TypeScript 项目可在 `src/env.d.ts` 或任意全局声明文件里补:

```ts
declare const __MOO_RELEASE__: string
```

## 可选:本地 build release 脚本

需要在 CI 外统一构建变量时,可维护一个项目内脚本:

```bash
#!/usr/bin/env bash
set -euo pipefail

export MOO_RELEASE="$(npx moo-monitor-release --fetch-tags --tag-prefix v)"
echo "MOO_RELEASE=$MOO_RELEASE"

npm run build
```

然后在 `vite.config.ts` 里优先使用环境变量:

```ts
const release = process.env.MOO_RELEASE || await resolveMooRelease({ tagPrefix: 'v' })
```

`archiveDir` 会把上传用的 `.map` 复制到 `archiveDir/release/app` 并写入 `manifest.json`。
它只做本地/CI 归档;真正用于云端还原的是每个文件直传七牛后 confirm 登记的结果。
如果归档目录放在项目内,建议把 `.moo-sourcemaps/` 加入 `.gitignore`,避免源码 map 入库。

## 直传契约与 CI 强约束

每个 `.map` 的 confirm 成功即代表云端已回查七牛对象大小与 SHA-256 一致(对象确实在七牛且内容正确)。
直传契约当前不强制返回 `health`;服务端若在 confirm 回执里附带 `health`(当前构建文件数、缺失文件数、
Debug ID 覆盖率、重复 Debug ID、源码上下文模式等),插件 `strict: true` 会沿用原有校验:

- 云端当前构建文件数与本次构建产物数一致;
- Debug ID 覆盖率为 100%;
- 没有重复 Debug ID。

`strict` 是独立的 CI 硬约束:配置缺失、任一文件的票据/直传/确认失败、或服务端返回的 health 不达标,
都会抛错阻断构建,不受 `failOnError: false` 影响。不返回 health 时,逐文件 confirm 回执即作为「该 map 可用」的强校验。
`failOnError` 只决定【未开启 `strict`】时普通上传/归档失败是否阻断构建。

SDK 侧可开启 `releaseCheck` 做运行时自检。它用浏览器里的 `frontend_errors` token 调只读接口 `/sourcemaps/check`,只返回聚合摘要,不暴露 map 文件或源码。自检异常通过 `onError` 返回,SDK 默认静默;要在开发环境看到诊断,需同时配置 `onError`。生产高流量站点可用采样:

```ts
app.use(MooMonitor, {
  endpoint: 'https://cloud.example.com/api/v1',
  token: import.meta.env.VITE_MOO_TOKEN,
  release: __MOO_RELEASE__,
  releaseCheck: { sampleRate: 0.01 },
  onError: (err) => console.warn('[moo-monitor]', err),
})
```

## 配额与限制

| 项 | 限制 |
| --- | --- |
| 资格 | 项目拥有者 VIP(非 VIP 上传返回 403 `vip_required`) |
| 保留 | 云端默认保留最近 **15 天 / 5 个 release**(按 release 版本整组清理,旧的连文件一起清);可在云端配置调整 |
| 大小 | 单文件 ≤ 20MB,单 release 合计 ≤ 50MB;每个 `.map` 单独请求,无 multipart 总包限制 |
| 格式 | Source Map v3(Vite/esbuild/webpack 默认产物);不支持 index map(带 `sections`) |
| 服务器 | 云端不接收 `.map` 字节,不再受 PHP `upload_max_filesize`/`post_max_size` 限制;构建机需能访问七牛直传域名(`upload.qiniup.com` 或 `upload-<region>.qiniup.com`) |
| 限流 | 票据与确认走云端 token 限流(默认 120 次/分钟);每个 map 3 次请求,大型 monorepo 可调云端 `INTAKE_RATE_LIMIT_PER_MIN` |

## 排查

| 症状 | 排查 |
| --- | --- |
| 详情里还是压缩位置 | ⓪ 插件与 SDK 是否都 ≥0.3.7(Debug ID 自动匹配,基本免排查);老接入:① release 是否三处一致(错误详情「上下文」里的 release vs Sourcemap 页的分组名);② 帧文件名(如 `index-abc123.js`)在该 release 分组下是否有同名工件;③ 部署的构建和上传 map 的构建是否同一次(文件名 hash 对不上就是两次构建) |
| 上传报 `HTTP 404` | `endpoint` 配错:少了 `/api/v1`、或填成了业务站域名 —— 与 SDK init 的 endpoint 是同一个值,原样照抄;插件内部自动拼 `/uploads/tickets` 与 `/uploads/{upload_id}/confirm` |
| 插件日志「未发现 .map 产物」 | `build.sourcemap` 没开;设 `'hidden'` 或 `true` |
| 403 `vip_required` | 项目拥有者不是 VIP;开通后重传 |
| 403(无 vip 字样) | token 没有 `sourcemaps` 能力(或混入了 `frontend_errors`),或已吊销/过期 |
| 401 token 无效 | 票据/确认要求 `Authorization: Bearer <token>`;确认 token 是专用 sourcemaps CI token、未过期 |
| 429 Too Many Attempts | 撞 token 级限流;插件会按 `Retry-After` 等一次重试。map 多时调高云端 `INTAKE_RATE_LIMIT_PER_MIN` |
| 单个文件确认被拒 | confirm 会回查七牛对象大小/SHA-256;看 reason:上传中断/对象不一致 / 文件名不合规 / 超 20MB |
| 七牛直传失败(未知区域) | 票据返回的 `region` 不在 z0/z1/z2/na0/as0;升级插件/脚本或检查云端「安装包存储」区域配置 |
| 部分帧未还原 | 正常:vendor chunk 没传 map、`native`/`eval` 帧、或该位置在 map 中无映射;还原成功的帧不受影响 |
| 上传成功但旧错误没变 | 旧错误 release 与本次上传不同 —— 只有同 release 的记录会重置重算 |

## 安全

- map 文件含源码,直传后存**七牛私有空间**,云端只保存元数据与校验结果;工件列表只显示元数据,文件本身不提供下载。
- `.map` 字节从构建机直达七牛,不经过云端;云端签发的七牛上传票据短效(默认 1 小时)且只允许指定 key/大小。
- 详情里展示的「出错源码」摘自 `sourcesContent`,入库前逐行截断并过密钥脱敏(`token=…`/JWT/Bearer 打码),
  且仅项目成员可见;若完全不想让源码上云,设 `sourceMode: 'position'`,插件会在上传和归档前剥掉 `sourcesContent`(代价:无源码上下文,只剩位置还原)。
- 生产站点建议 `sourcemap: 'hidden'` + `deleteAfterUpload: true`:`.map` 不留在服务器、产物里也没有指向注释。
- 上传 token 与浏览器 token 分离(能力隔离),泄漏面只在 CI。
