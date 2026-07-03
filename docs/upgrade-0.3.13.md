# 升级到 0.3.13 · 前端接入 & 验收

这版围绕 **sourcemap 还原** 加了几项能力，都是 **opt-in**——不主动加配置，等于没升级。

> 前提：项目拥有者已是 **VIP**；CI/构建有一枚**只勾「Sourcemap 上传」**的 token（别用浏览器上报 token，会被 403）。

## 你能得到什么

- **strict**：CI 里 map 没传齐 / Debug ID 不全 / 有重复，直接挡构建——不让「发了版但栈还原不了」蒙混过去。
- **releaseCheck**：开发/灰度时浏览器自检「代码已发、map 没传或传错」，只 `console.warn` 不打扰用户。
- **sourceMode: 'position'**：源码敏感的项目可只还原「文件/行/列」，不把源码上云。
- **resolveMooRelease()**：自动用 git 算 release 号，构建上传与运行上报共用同一个值。

## 升级步骤（3 步）

```bash
npm update moo-monitor-vue      # 或重装 git+https，见 local-testing.md
```

1. **vite.config**：加 `mooSourcemapUpload({ ..., strict: true, sourceMode: 'context' })`，release 用 `await resolveMooRelease()`。
2. **SDK init**：`release` 传同一个值；开发/灰度加 `releaseCheck: import.meta.env.DEV`。
3. **CI**：配好 `MOO_SOURCEMAP_TOKEN`（只勾 Sourcemap 上传）。

> 完整 snippet 见云端 `/app → 集成接入` 页，或 `docs/sourcemaps.md`。

## 验收清单（照着勾，确认真生效）

| # | 操作 | 预期 |
|---|---|---|
| 1 | 本地/CI 构建一次 | 日志出现「已上传 N 个 sourcemap（release …）」 |
| 2 | 云端 `设置 → Sourcemap` | 看到本次 release 的工件；`数据 → 前端发布` 有「可还原率」 |
| 3 | 线上/灰度触发一个真实前端报错 | 云端「前端错误」详情里是 **`.vue` 源码位置 + 出错源码块**，不是压缩栈（还原约 2 分钟生效） |
| 4 | 故意删一个 `.map` 或设 `injectDebugIds: false` 再构建 | **CI 构建失败**，报「缺文件 / Debug ID 覆盖率不足」 |
| 5 | 开发模式跑一次（map 不上传或 release 对不上） | 浏览器 console 出现 `releaseCheck` 的 warn |

第 4、5 条验完记得**改回正常配置**。

## 出问题看哪

- 报错码对照（404 / 403 vip_required / 403 mixed_token / strict 无 health）：云端 `/app → 集成接入` 页。
- 排查与安全边界：`docs/sourcemaps.md`。
- 装包方式（git / tarball / link）：`docs/local-testing.md`。
