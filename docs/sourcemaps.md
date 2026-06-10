# sourcemap 还原 —— 接入与排查

> 适用:moo-monitor-vue ≥ 0.3.0 + moo-scaffold-cloud(含 `/api/v1/sourcemaps/intake`)。**VIP 专享**(按项目拥有者会员判定)。

## 原理一页纸

```
CI 构建(vite build, sourcemap: 'hidden')
  └─ mooSourcemapUpload 插件:收集 dist/**/*.js.map
       └─ POST /api/v1/sourcemaps/intake(multipart:token + release + files[])
            └─ 云端落私有盘 + 登记 release_artifacts(按 project+release+产物名 覆盖式 upsert)

浏览器报错 → SDK 上报 frames(压缩位置 file:line:column)+ release
  └─ 云端 intake 后异步任务(或打开详情时兜底)按
       「帧文件 basename == 工件 file_name && release 完全一致」
     找到 map → 流式 VLQ 解析 → 还原成源码 file:line:column(+ 函数名)
  └─ 生效处:详情抽屉「调用栈」/「复制给 AI 修复」markdown / 列表摘要(出错组件,如 Foo.vue)
```

- **还原结果缓存在错误记录上**(`src_frames`),不会每次打开都重算;同 release 重新上传 map 会自动重置缓存、触发重算。
- **错误先到、map 后到没关系**:上传完成后该 release 的存量错误会重新还原。
- 还原不出的帧(vendor 没传 map、`native`/`eval` 帧、map 里无映射区间)原样显示压缩位置,不影响其他帧。

## 接入清单

1. **token**:`/app → 接入 Token → 生成`,只勾 **「Sourcemap 上传」**,存进 CI 的 secret(如 `MOO_SOURCEMAP_TOKEN`)。
   - ⚠️ 不要复用浏览器里的 `frontend_errors` token:那枚是公开的,复用 = 任何人都能灌/覆盖你的 map。
2. **vite.config.ts**:`build.sourcemap: 'hidden'` + `mooSourcemapUpload({ endpoint, token, release, deleteAfterUpload: true })`。
3. **release 三处一致**(这是最常见的翻车点):
   - SDK `init({ release })`(运行时,随错误上报);
   - 插件 `release`(构建时,随 map 上传);
   - 两者必须来自同一个值(版本号或 commit sha),且与线上实际部署的构建对应。
4. 发版后到 `/app → 设置 → Sourcemap` 确认工件已出现在对应 release 分组下。

## 配额与限制

| 项 | 限制 |
| --- | --- |
| 资格 | 项目拥有者 VIP(非 VIP 上传返回 403 `vip_required`) |
| 保留 | 每项目滚动保留最近 **20 个 release**(按上传时间,旧的连文件一起清) |
| 大小 | 单文件 ≤ 20MB,单 release 合计 ≤ 50MB,单请求 ≤ 50 个文件 |
| 格式 | Source Map v3(Vite/esbuild/webpack 默认产物);不支持 index map(带 `sections`) |
| 服务器 | 上传走 multipart,需云端 PHP `upload_max_filesize`/`post_max_size` ≥ 20M |

## 排查

| 症状 | 排查 |
| --- | --- |
| 详情里还是压缩位置 | ① release 是否三处一致(错误详情「上下文」里的 release vs Sourcemap 页的分组名);② 帧文件名(如 `index-abc123.js`)在该 release 分组下是否有同名工件;③ 部署的构建和上传 map 的构建是否同一次(文件名 hash 对不上就是两次构建) |
| 插件日志「未发现 .map 产物」 | `build.sourcemap` 没开;设 `'hidden'` 或 `true` |
| 403 `vip_required` | 项目拥有者不是 VIP;开通后重传 |
| 403(无 vip 字样) | token 没有 `sourcemaps` 能力,或已吊销/过期 |
| 文件被逐个拒绝(errors) | 看返回的 reason:文件名不合规(须 `产物名.map`)/ 超 20MB / 不是合法 Source Map v3 |
| 部分帧未还原 | 正常:vendor chunk 没传 map、`native`/`eval` 帧、或该位置在 map 中无映射;还原成功的帧不受影响 |
| 上传成功但旧错误没变 | 旧错误 release 与本次上传不同 —— 只有同 release 的记录会重置重算 |

## 安全

- map 文件含源码,云端存**私有盘**,仅项目成员经面板可见(工件列表只显示元数据,文件本身不提供下载)。
- 生产站点建议 `sourcemap: 'hidden'` + `deleteAfterUpload: true`:`.map` 不留在服务器、产物里也没有指向注释。
- 上传 token 与浏览器 token 分离(能力隔离),泄漏面只在 CI。
