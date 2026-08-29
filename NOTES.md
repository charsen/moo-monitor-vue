# NOTES.md — moo-monitor-vue 长期记忆

> 每次开工先读。这里只记录经代码、测试、真实浏览器或构建产物验证，且以后仍可复用的坑、决策和稳定做法；不记录任务进度、猜测和容易过期的数量快照。

## 已确认边界

- `autoBreadcrumbs: false` 只关闭行为轨迹；`httpErrors` 默认仍会安装 fetch/XHR 插桩并捕获达到阈值的响应。要完全不修改 fetch/XHR，必须同时关闭 `httpErrors`。
- 脱敏必须发生在字符串截断之前；长 JWT 或 OAuth hash 先截断会留下不再匹配完整 JWT 正则的敏感残段。
- 同一个 XHR 实例可被重复使用；监听和 method/URL 状态必须按单次请求重置，否则会重复上报并把后一请求归因到前一请求。
- Vue errorHandler、Router onError 与全局错误监听可能收到同一个 Error；沿用错误对象上的去重标记，内部标记不得进入 payload 或指纹。
- Debug ID 注入在 `writeBundle` 后改写 JS，与较早阶段计算的 SRI integrity 不兼容；启用 SRI 时关闭 `injectDebugIds`。
- 同一 release 的多个 Rollup output 若共用 `app`，后上传的 build set 会替换先上传的 maps；modern/legacy 或多应用输出必须使用不同 `app`。
- 在 `transform`、`renderChunk` 或上传阶段清空特定模块/chunk 的 map，虽能显著缩小 map 文件，却不能稳定降低 Rollup sourcemap 构建峰值；Node 22 大型 host 交换顺序 A/B 出现反向波动。要降低峰值必须从模块图中拆分或移除大型预打包依赖，不能把 `include`、`sourceMode: 'position'` 或空映射策略宣传为堆内存优化。
