# moo-monitor-vue

轻量 **Vue 3 前端异常监控 SDK** —— 捕获浏览器 JS 错误并上报到 [Moo Scaffold Cloud](https://gitee.com/charsen/moo-scaffold-cloud) 的前端错误管道,在云端按指纹聚合、三诊(待处理 / 处理中 / 已解决)。

> 对标 Sentry 的浏览器 SDK,但精简自建:只做**异常捕获 + 行为轨迹 + 上下文 + 可靠上报**,零运行时依赖(gzip ≈ 4.3KB)。

## 特性

- **四大捕获通道**(不漏报):`window.onerror`(带 `error.stack`)+ 未处理 Promise(`unhandledrejection`)+ **Vue `app.config.errorHandler`**(Vue 吞掉的渲染/生命周期错误不冒泡到 `onerror`,必须单独接)+ 资源加载错误(捕获阶段)。
- **行为轨迹 breadcrumbs**:点击、fetch 请求自动记录(环形队列),随错误一起上报,还原「报错前发生了什么」。
- **上下文**:`release`(版本,为日后 source map 还原预留)、`env`、用户(`setUser`)、浏览器/系统(UA 解析)、自定义 `tags`/`extra`。
- **可靠上报**:客户端按指纹**合并计数**(同错误累加 `count`、风暴不刷屏)、`sampleRate` 采样、`ignoreErrors` 噪音过滤、批量队列(按字节分批避开 64KB 上限)、页面卸载(`pagehide`/`visibilitychange`)用 `sendBeacon` 兜底发送(失败回退 `fetch keepalive`)。
- **分层**:框架无关 `core` + 薄 Vue 适配层 —— `core` 可单独用于任意 JS 项目。

## 安装

```bash
npm i moo-monitor-vue
```

`vue` 为 peerDependency(`^3.3`),不会重复打包。

> 🚧 **尚未发布到 npm**:上面的命令暂时装不到。发布前请从 gitee 源码安装(`npm i git+https://gitee.com/charsen/moo-monitor-vue.git`),详见 **[发布前安装测试指南 → docs/local-testing.md](docs/local-testing.md)**(含云端拿 token、验证闭环、排查清单)。

## 快速开始(Vue 3)

```ts
import { createApp } from 'vue'
import App from './App.vue'
import MooMonitor from 'moo-monitor-vue/vue'

const app = createApp(App)

app.use(MooMonitor, {
  endpoint: import.meta.env.VITE_MOO_ENDPOINT, // 云端 /api/v1 基址
  token: import.meta.env.VITE_MOO_TOKEN,       // 项目推送 token(需含 frontend_errors 权限)
  env: import.meta.env.MODE,                   // production / staging / ...
  release: __APP_VERSION__,                     // 版本号(建议注入 build 时的版本/commit)
  sampleRate: 1,
  ignoreErrors: ['ResizeObserver loop', /^Script error\.?$/],
  // beforeSend: (e) => (e.error.message.includes('secret') ? null : e),
})

app.mount('#app')
```

装上后,Vue 组件错误、全局 JS 错误、未处理 Promise、资源加载失败都会自动上报。

## 命令式 API

```ts
import { captureException, captureMessage, setUser, setTag, addBreadcrumb } from 'moo-monitor-vue'

setUser({ id: 42, name: 'kim' })             // 登录后注入;登出 setUser(null)
setTag('tenant', 'acme')

try {
  risky()
} catch (e) {
  captureException(e, { tags: { area: 'checkout' }, extra: { cartId: 'c_99' } })
}

captureMessage('用户点了一个理论上不可达的按钮', 'warning')
```

组件内也可用 `this.$moo` 或 `inject('mooMonitor')` 拿到 client。

> 只用 `core`(不装 Vue)?`import { init, captureException } from 'moo-monitor-vue'` 后 `init({ endpoint, token })` 即可。

## 配置项

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `endpoint` | — | **必填**。云端 API 基址,如 `https://cloud.example.com/api/v1`(内部拼 `/frontend-errors/intake`) |
| `token` | — | **必填**。项目推送 token(需含 `frontend_errors` 权限) |
| `env` | `'production'` | 环境标识 |
| `release` | — | 版本号(source map 还原 / 按版本聚合的关键) |
| `project` | `'web'` | 来源标识(区分前后端) |
| `sampleRate` | `1` | 错误采样率 0..1 |
| `maxBreadcrumbs` | `30` | 行为轨迹队列上限 |
| `flushInterval` | `5000` | 批量上报间隔(ms) |
| `maxBatch` | `20` | 单批最多条数 |
| `enabled` | `true` | 总开关 |
| `autoCapture` | `true` | 自动捕获全局/Promise/资源错误 |
| `autoBreadcrumbs` | `true` | 自动记录点击 / fetch 轨迹 |
| `ignoreErrors` | `[]` | 噪音过滤(字符串包含 / 正则) |
| `beforeSend` | — | 发送前钩子,返回 `null` 丢弃 |

## 云端准备

1. 在 Moo Scaffold Cloud 的项目里,到 **接入 Token** 生成一枚勾选了 **「前端错误上报 (Vue SDK)」** 权限的 token。
2. 把 `endpoint`(`https://<你的云端>/api/v1`)与 `token` 配进 SDK。
3. 上报的错误会出现在该项目的 **「前端错误」** 列表里(按指纹聚合、带趋势 / breadcrumbs / 调用栈)。

> ⚠️ 安全提示:token 会出现在客户端 JS 中。它是**只写**令牌(只能上报、不能读),但仍建议为前端单独签发、并关注配额。后续云端会支持按域名白名单的公共上报公钥。

## 规模化与限流

- **批量降频**:SDK 按 `flushInterval`(默认 5s)+ `maxBatch` 合并上报,单个用户每分钟请求数很低;但**同一前端 token 被所有访客共享**,高流量站点的聚合请求可能撞到云端 **per-token 限流**(默认 `INTAKE_RATE_LIMIT_PER_MIN=120/min`),超出会 429 且 SDK 不重试(丢弃)。应对:为前端单独签发 token、按量调高云端 `INTAKE_RATE_LIMIT_PER_MIN`,并用 `sampleRate` 在客户端降采样。
- **per-IP 限流**:云端还有 per-IP 限流(默认 `max(perMin×5, 600)/min`);办公网 / NAT 下大量用户共享出口 IP 时需留意。
- **配额**:免费档每项目只保留**最新 30 条**前端错误(VIP 不限);高基数错误(大量不同指纹)会快速 churn —— 善用 `ignoreErrors` + `sampleRate` + 云端「忽略/静音」收敛。
- **CORS**:云端对 `/api/v1/*` 放行任意 origin 的 `POST`,但**只允许 `Content-Type` / `Accept` 头**。SDK 因此把 token 放在请求体、不加任何自定义头;**请勿**给 SDK 加自定义请求头(会触发预检失败)。

## 上报数据形态

每条错误以 `{ token, records: [ ... ] }` POST 到 `/frontend-errors/intake`,record 形如:

```jsonc
{
  "hash": "ab12cd34ef56",            // 客户端指纹(类型+消息+栈顶帧),12 位 hex
  "error": { "name": "TypeError", "message": "...", "stack": "...", "handled": false, "severity": "error" },
  "page": { "url": "https://.../cart", "referrer": "..." },
  "client": { "user_agent": "...", "browser": "Chrome", "browser_version": "120", "os": "macOS" },
  "context": { "env": "production", "release": "2.3.1", "project": "web", "occurred_at": "..." },
  "frames": [ { "file": "Cart.vue", "line": 42, "column": 18, "function": "renderCart" } ],
  "breadcrumbs": [ { "category": "click", "message": "button#checkout" } ],
  "user": { "id": "42", "name": "kim" },
  "payload": { "tags": { "area": "checkout" } }
}
```

## 开发

```bash
npm i
npm test          # vitest
npm run typecheck  # tsc --noEmit
npm run build      # vite library 构建 → dist/(esm + cjs + d.ts)
```

## 路线图

- [ ] source map 上传 + 云端还原(SDK 已带 `release`,先打通采集)
- [ ] localStorage 持久离线队列 + 在线重放
- [ ] 性能 / Web Vitals(与异常监控正交)
- [ ] 按域名白名单的公共上报公钥

## License

MIT © charsen
