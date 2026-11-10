# Sentry SDK 小范围学习

本次只对照发送资源边界、失败回收和平台分工，未做 Sentry 全功能移植，也不代表六个 SDK 的完整审计。

## 采用的做法

Sentry JavaScript 的 [PromiseBuffer](https://github.com/getsentry/sentry-javascript/blob/2f3c8a9448451feee7192fb51e897dfe15155b52/packages/core/src/utils/promisebuffer.ts) 在启动任务前检查容量，并在成功和失败时移除任务；[浏览器 fetch transport](https://github.com/getsentry/sentry-javascript/blob/2f3c8a9448451feee7192fb51e897dfe15155b52/packages/browser/src/transports/fetch.ts) 还跟踪在途数量与 body 大小，约束 keepalive 的使用。

这里学习资源有界的原则，独立实现更小的发送闸：

- 同一模块最多 4 个在途上报请求，重复初始化及卸载发送共用预算；4 是本包的批量发送取舍，并非照搬 Sentry 的默认值。
- 容量不足时返回未派发，记录按原顺序留在原有 200 条队列，后续 flush 再尝试；不新增第二层队列，不消耗网络重试机会。
- 支持 `AbortController` 时，15 秒后取消尚未返回响应头的请求，继续使用现有 `network` 失败分类与最多一次重试。这个超时是本包的保护策略，不宣称 Sentry 浏览器 transport 有相同超时。
- 只有实际 fetch 成功、拒绝或同步调用失败才释放名额，并清理计时器；取消不生效时继续占位。缺少 `AbortController` 时保留有界发送，无法保证 15 秒取消。页面冻结也可能延后定时器。
- close 保持原有“最后一次 keepalive 尽力发送后关闭队列”语义；晚到失败不能复活队列。`flush()` 仍表示派发结果，内存队列及浏览器共享配额不能保证退出前送达。

## 其他 SDK 的对照与取舍

| SDK | 对照到的现有保护 | 本轮处理 |
| --- | --- | --- |
| Android | WorkManager 唯一工作链、调度占位，连接和读取超时 | 保留 |
| iOS | actor 内 busy 闸、请求超时、本地队列 | 保留，不触碰信号处理 |
| Flutter | 共用进行中的 flush Future、整体发送超时后关闭 HttpClient | 保留 |
| Go | 同步入口闸、作用域文件锁、默认 HTTP 超时和 context | 保留 |
| Laravel | 按类型锁住同步全流程、默认 HTTP 超时 | 保留；本轮未扩展配置异常值审核 |
| Vue | 原有 200 条待发上限、字节分批、一次失败重试 | 补在途上限、取消等待和回插顺序 |

Sentry 的 [Java transport](https://github.com/getsentry/sentry-java/blob/ff7a1ac0da368a07470cee75c502a9cfa9d90cce/sentry/src/main/java/io/sentry/transport/AsyncHttpTransport.java) 使用有限执行队列；[Cocoa transport](https://github.com/getsentry/sentry-cocoa/blob/9c3efcabe12c18448742646ba27f3fd71abdf022/Sources/Sentry/SentryHttpTransport.m) 控制缓存发送重入；[Go transport](https://github.com/getsentry/sentry-go/blob/75d694131543833fce1ee301ddc67b635a20c5ad/transport.go) 使用有界队列和超时。可以统一保护目标，具体实现继续服从各平台运行方式。

Sentry 的 [Flutter 插件声明](https://github.com/getsentry/sentry-dart/blob/69deea7468bb1f03727fe6a1d8fb81508e4e31ef/packages/flutter/pubspec.yaml) 同样包含不同平台的原生入口。现有 Flutter 的原生崩溃桥接继续留作独立设计，先解决身份、去重和双队列问题，不借本轮扩大范围。

本轮未引入 Sentry 依赖、协议、分类限流头、录屏、Tracing、Profiling 或统一跨语言内核；公共接口、配置项和版本保持原样。

## 定向验证范围

- 慢端点下持续捕获不同错误，在途与待发分别有界，溢出仍有回执。
- 分批未派发时的顺序、容量恢复后的定时继续发送，以及等待容量不消耗失败重试。
- 15 秒取消、响应和各种失败清理、缺少或忽略取消能力的降级。
- close 后晚到超时不能重新调度；既有 429、重定向、失败分类和回调隔离继续成立。
- 本机回环 HTTP 验证实际取消连接与容量恢复；它是传输层定向集成测试，不替代浏览器或业务流程验收。

## 2026-11-10 验证记录

- 新增边界单测 13 项：旧代码 12 项失败、1 项通过；修复后全部通过。
- 既有 `transport`、`queue`、`delivery-backoff`、`cross-sdk-hardening`、`redirect-policy` 五组定向用例 36 项通过。
- 新增真实回环 HTTP 用例通过：12 次派发尝试只建立 4 个悬挂请求，约 15 秒后四条连接实际关闭，再次发送成功。以上合计 50 项定向测试。
- `npm run typecheck`、受影响 TypeScript 文件的 ESLint、`npm run build` 和 `git diff --check` 通过。
- core ESM gzip 从 12,831 增至 13,064 字节（+233）；六个 ESM/CJS 构建入口的导出名一致，Vue/Vite 适配入口体积不变。
- 未运行全量测试、浏览器或设备 E2E；未发布包或递增版本。
