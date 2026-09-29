# AGENTS.md

本文件适用于整个 `moo-monitor-vue` 仓库。规则冲突时依次服从系统/用户指令、当前代理规则、用户批准的方案、`NOTES.md`、`docs/` 与历史调优计划。README 和计划中的版本快照必须用当前 package、源码、测试和构建产物核实。

## 开工顺序与长期记忆

1. 先读 `NOTES.md`，再读 `README.md`、`docs/overview.md` 与任务对应的 sourcemap/升级/调优文档。
2. 按入口追调用链：core 采集与投递在 `src/core`，Vue 适配在 `src/vue`，Vite/release 在 `src/vite` 和 `bin`。
3. 改文件前读目标文件、直接调用方和对应测试。机械性、零语义且范围明确的小修可直接实施；非琐碎或涉及隐私、上报契约、公共导出、构建产物的改动先列计划并取得用户批准，范围或风险实质变化时重新确认。

- `NOTES.md` 只记录经测试、浏览器或构建流程确认且可复用的坑/决策；不记录任务进度、猜测、固定用例数量或 README 已清楚表达的普通功能。
- 新证据推翻旧结论时更新原条目；不记录浏览器 token、上传 token、真实 endpoint、用户数据或源码内容。

## 项目定位与入口边界

- 本仓同时提供零运行时依赖的浏览器监控 core、Vue 3 薄适配和 Node/Vite sourcemap 构建插件，三者运行环境不同，不得互相泄漏浏览器/Node 专用 API。
- core 捕获 JS/Promise/资源/Vue/HTTP/手动错误，并携带有限 breadcrumbs；它不是行为分析、录屏、性能或正常请求采集 SDK。
- Vue 插件必须保留宿主已有 `app.config.errorHandler`，并避免 Router、全局 handler 和手动捕获对同一 Error 双计。
- `/vite` 入口只在构建期运行，不能进入浏览器 bundle；Vue 是 optional peer，core 仍需可被非 Vue 项目独立导入。
- `src/index.ts`、`src/vue/index.ts`、`src/vite/index.ts` 的导出、package `exports` 和生成的 `.d.ts` 是公共 API。

## 隐私与采集不变量

- 键盘轨迹绝不记录按键内容或输入值；输入元素描述不读取 value，密码和 token 不进入 breadcrumbs。
- fetch/XHR 轨迹只记录 method、去敏 URL 和 status，不抓请求体、响应体、cookie 或 authorization；上报使用 `credentials: omit`。
- scrub 必须在截断前执行，并覆盖 message、stack、page、frames/breadcrumbs 等所有出站路径；JWT、Bearer、token/access_token/id_token 等不得留下可复原残段。
- `beforeSend` 是最后的改写/丢弃闸口；SDK 自身失败交给 `onError` 且不得抛回宿主。
- 指纹必须对同类错误稳定、对不同根因有区分；云端会重算防投毒，客户端 hash 仍决定本地合并行为。
- 自动插桩的 install/close 必须成对：恢复原 handler/fetch/XHR/history/listener，单个卸载失败不能阻断其他清理，close 前按现有语义 flush。

## 队列与传输

- 队列按 UTF-8 真实字节限制分批，超限时分级截断；同一 flush 内聚合，失败批按原顺序回收，不能因并发 flush、429 或半失败丢记录/重复风暴。
- fetch 为常态通道，页面卸载使用 sendBeacon；429 遵循 Retry-After，失败分类和 retry 语义保持公开回调契约。
- `autoBreadcrumbs` 与 `httpErrors` 是正交开关：关闭轨迹不应静默关闭 HTTP 错误捕获；要完全不 patch fetch/XHR 必须两者都关闭。
- SSR/无 window 环境必须安全 no-op；不得因模块级单例扩大到未承诺的 per-request SSR 多实例能力。

## Sourcemap、Debug ID 与发布

- SDK `release`、构建插件上传和云端展示应来自同一生成方式；Debug ID 优先绑定 bundle 与 map，老接入仍依赖 release + basename。
- 注入 Debug ID 会改写最终 JS，与提前计算的 SRI 不兼容；使用 SRI 时必须关闭注入并明确退化匹配策略。
- 多 output/多 app 必须使用不同 `app` 标识，避免同 release 下 build set 互相替换；同名 map basename 必须告警/拒绝含糊归档。
- 浏览器上报 token 是只写公开凭据，sourcemap 上传 token 是 CI 密钥，两者严禁复用；map 上传后是否删除、是否包含 sourcesContent 按明确选项执行。
- 发布版本、package metadata、dist、tag 和 npm publish 都是发版动作，不随普通修复自动修改。

## 验证与交付

- 文档-only 至少运行 `git diff --check`。TypeScript 改动先跑目标 Vitest，再执行 `npm run typecheck`、`npm run lint`、`npm test` 和 `npm run build`。
- 重构公共入口时对比构建前后顶层导出与 `.d.ts`，检查 core/vue/vite 三入口；对体积敏感改动核对 dist 大小而非凭感觉。
- 插桩改动覆盖 install、触发、close 后不再触发；隐私改动加入长 JWT、截断边界、URL/hash 和 XHR/fetch 双通道测试。
- Vite 插件改动用真实临时构建验证 Debug ID、map、archive/delete、strict 和多 output 语义；单元 mock 不能替代完整产物检查。
- 不主动 commit、push、bump、tag 或 npm publish。提交前展示完整 diff 和真实验证结果并取得用户明确确认。

- **本仓是公开仓**（GitHub 匿名可见）：文档、提交信息、注释与产物里**不得出现未开源扩展包名与内部项目名**，统一写 `moo-<name>`、"某个内部 Host" 等中性表述；含内部信息的清单/方案放私有 plan 库。
