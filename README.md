# moo-monitor-vue

轻量 **Vue 3 前端异常监控 SDK** —— 捕获浏览器 JS 错误并上报到 [Moo Scaffold Cloud](https://gitee.com/charsen/moo-scaffold-cloud) 的前端错误管道,在云端按指纹聚合、三诊(待处理 / 处理中 / 已解决)。

> 对标 Sentry 的浏览器 SDK,但精简自建:只做**异常捕获 + 行为轨迹 + 上下文 + 可靠上报**,零运行时依赖(gzip ≈ 12KB)。

## 特性

- **四大捕获通道**(不漏报):`window.onerror`(带 `error.stack`)+ 未处理 Promise(`unhandledrejection`)+ **Vue `app.config.errorHandler`**(Vue 吞掉的渲染/生命周期错误不冒泡到 `onerror`,必须单独接)+ 资源加载错误(捕获阶段)。
- **行为轨迹 breadcrumbs**:点击(解析到就近交互元素 + 可读文本)、键盘关键节点(Enter/Escape + 「开始输入」聚合,**绝不记输入内容**)、SPA 路由跳转(`from → to`)、fetch 请求 —— 自动串成「报错前用户做了什么」的操作链路;另自动捕获 **HTTP ≥500 响应**为错误、自动生成**会话 ID**(影响用户数可统计)。
- **上下文**:`release`(版本,sourcemap 还原的匹配键)、`env`、用户(`setUser`)、浏览器/系统(UA 解析)、自定义 `tags`/`extra`。
- **sourcemap 还原(VIP)**:配套 Vite 插件构建后自动上传 `.map`,云端把压缩堆栈还原成源码位置(`.vue` 文件即出错组件),见 [sourcemap 还原](#sourcemap-还原vip)。
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
import router from './router'
import MooMonitor from 'moo-monitor-vue/vue'

const app = createApp(App)

app.use(MooMonitor, {
  endpoint: import.meta.env.VITE_MOO_ENDPOINT, // 云端 /api/v1 基址
  token: import.meta.env.VITE_MOO_TOKEN,       // 项目推送 token(需含 frontend_errors 权限)
  env: import.meta.env.MODE,                   // production / staging / ...
  release: __APP_VERSION__,                     // 版本号(建议注入 build 时的版本/commit)
  // releaseCheck: import.meta.env.DEV || import.meta.env.MODE === 'staging',
  sampleRate: 1,
  ignoreErrors: ['ResizeObserver loop', /^Script error\.?$/],
  router,                                       // 可选:传入 Vue Router → 捕获懒加载 chunk 失败(发版后旧 chunk 404)
  // beforeSend: (e) => (e.error.message.includes('secret') ? null : e),
})

app.mount('#app')
```

装上后,Vue 组件错误、全局 JS 错误、未处理 Promise、资源加载失败都会自动上报。传入 `router` 还会捕获「Loading chunk failed / 动态 import 失败」(这类不进 errorHandler / window.onerror)。

> **微前端 / HMR**:重复 `init()` 会自动关掉旧实例(解绑监听器 + 还原 `fetch`);也可手动 `import { close } from 'moo-monitor-vue'` 调 `close()` 卸载。**SSR/Nuxt**:服务端只暴露命令式 API,不接管浏览器侧捕获(服务端错误交给后端监控)。

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
| `autoBreadcrumbs` | `true` | 自动记录点击 / 键盘 / 路由 / fetch 轨迹(键盘只记按键与目标,绝不记内容) |
| `autoSession` | `true` | 自动生成会话 ID(sessionStorage,标签页生命周期);`setUser({ sessionId })` 优先 |
| `releaseCheck` | `false` | 可选 release 自检。`true` 或 `{ sampleRate, app }` 会用前端错误 token 查询云端 sourcemap 健康摘要,建议开发/灰度开启 |
| `httpErrors` | `true` | fetch/XHR 响应 ≥500 自动捕获为 `HttpError`;`{ min: 400 }` 降阈值;`false` 关闭。**独立于 `autoBreadcrumbs` 生效**——关轨迹不会连带关掉 HTTP 错误捕获;要完全不打 fetch/XHR 补丁,需同时设 `httpErrors: false` |
| `ignoreErrors` | `[]` | 噪音过滤(字符串包含 / 正则)。建议过滤浏览器良性噪音:`['ResizeObserver loop', /^Script error\.?$/]` |
| `ignoreFetchUrls` | 内置统计域名 | 请求轨迹忽略名单(GA/GTM/百度统计/友盟/神策等默认忽略,传 `[]` 全保留) |
| `beforeSend` | — | 发送前钩子,返回 `null` 丢弃 |
| `onError` | — | SDK 自身错误 / 丢弃回执回调(默认静默,绝不抛回宿主) |

## 云端准备

1. 在 Moo Scaffold Cloud 的项目里,到 **接入 Token** 生成一枚勾选了 **「前端错误上报 (Vue SDK)」** 权限的 token。
2. 把 `endpoint`(`https://<你的云端>/api/v1`)与 `token` 配进 SDK。
3. 上报的错误会出现在该项目的 **「前端错误」** 列表里(按指纹聚合、带趋势 / breadcrumbs / 调用栈)。

> ⚠️ 安全提示:token 会出现在客户端 JS 中。它是**只写**令牌(只能上报、不能读),但仍建议为前端单独签发、并关注配额。后续云端会支持按域名白名单的公共上报公钥。

## 规模化与限流

- **批量降频**:SDK 按 `flushInterval`(默认 5s)+ `maxBatch` 合并上报,单个用户每分钟请求数很低;但**同一前端 token 被所有访客共享**,高流量站点的聚合请求可能撞到云端 **per-token 限流**(默认 `INTAKE_RATE_LIMIT_PER_MIN=120/min`),超出会 429:SDK 进入退避(按 Retry-After),被拒的批回收重试一次,仍失败才丢弃(经 `onError` 可感知)。应对:为前端单独签发 token、按量调高云端 `INTAKE_RATE_LIMIT_PER_MIN`,并用 `sampleRate` 在客户端降采样。
- **per-IP 限流**:云端还有 per-IP 限流(默认 `max(perMin×5, 600)/min`);办公网 / NAT 下大量用户共享出口 IP 时需留意。
- **配额**:免费档每项目只保留**最新 30 条**前端错误(VIP 不限);高基数错误(大量不同指纹)会快速 churn —— 善用 `ignoreErrors` + `sampleRate` + 云端「忽略/静音」收敛。
- **CORS**:云端对 `/api/v1/*` 放行任意 origin 的 `POST`,但**只允许 `Content-Type` / `Accept` 头**。SDK 因此把 token 放在请求体、不加任何自定义头;**请勿**给 SDK 加自定义请求头(会触发预检失败)。

## 采集范围(采什么 / 不采什么)

这是个**前端异常监控**:只采集「错误」类事件 + 出错现场的环境与行为轨迹,**不**采集正常业务数据、性能指标或录屏。

**捕获来源(6 类,都是错误):**

1. 未捕获的 JS 运行时错误 —— `window.onerror`(带堆栈)
2. 未处理的 Promise 拒绝 —— `unhandledrejection`
3. Vue 组件错误 —— `app.config.errorHandler`(渲染/生命周期/watch,这些不冒泡到 `onerror`,故单独接)
4. 资源加载失败 —— 捕获阶段 error 事件(img/script/css 404 等,记为 `warning`)
5. HTTP 响应错误 —— 经包裹的 fetch **与 XMLHttpRequest(axios)**,状态码 ≥500(可调 / 可关)记为 `HttpError`
6. 手动上报 —— `captureException(e)` / `captureMessage('…')`

> 不会上报:正常接口请求、性能指标(FCP/LCP…)、用户行为本身、页面录屏 —— 均不在 v1 范围(见[路线图](#路线图))。

**每条错误携带的信息:**

| 类别 | 字段 |
| --- | --- |
| 错误本身 | 类型(`TypeError`…)、消息、堆栈、是否主动捕获(`handled`)、严重度 |
| 解析后调用栈 | `frames`(文件 / 行 / 列 / 函数名) |
| 页面 | 出错页面 URL、referrer |
| 浏览器 / 设备 | UA、浏览器 + 版本、系统、设备类型(Mobile/Tablet/Desktop) |
| 上下文 | 环境 `env`、版本 `release`、来源 `project`、发生时间 |
| 行为轨迹 `breadcrumbs` | 报错前的**点击**(交互元素 + 可读文本)、**键盘关键节点**(Enter/Escape、「开始输入」,无内容)、**路由跳转**(from → to)与 **fetch 请求**(method/url/status);环形队列约 30 条 |
| 用户 | `id` / `name`(需 `setUser(...)`);`session_id` 自动生成(标签页生命周期,可关) |
| 自定义 | `tags` / `extra`(`captureException(e, { tags, extra })` 传入) |
| 聚合 | 指纹 `hash`、出现次数 `count`、首次 / 最近时间 |

**隐私与边界:**

- **键盘绝不记内容**:只记 Enter/Escape 与「开始在某输入框打字」这件事,按键值 / 输入值 / 密码一概不采;输入控件的描述只用 name/placeholder/type。
- **breadcrumbs 里的 fetch 是「轨迹」不是「上报」**:平时不单独发,只在真出错时随错误一起带上;只记 url/method/status,**不抓请求 / 响应体**。
- **不发 cookie / 凭证**(`credentials: 'omit'`);token 放请求体。
- **脱敏**:消息 / 堆栈 / 页面 URL / 轨迹里像密钥的内容(`token=…`、JWT、`Bearer …`)**在 SDK 出站前就打码**(密钥不离开浏览器);云端写入与读取时再各兜底一层。
- **聚合而非逐条风暴**:同一错误按指纹合并、累加 `count`、批量发送。

## 上报数据形态

每条错误以 `{ token, records: [ ... ] }` POST 到 `/frontend-errors/intake`,record 形如:

```jsonc
{
  "hash": "ab12cd34ef56",            // 客户端指纹(仅用于 SDK 端合并;云端忽略并重算,防投毒)
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

## sourcemap 还原(VIP)

生产构建是压缩过的,堆栈里只有 `index-abc123.js:1:23456` 这类位置。把构建产物的 `.map` 上传到云端后,
错误详情的调用栈会还原成 `src/components/Foo.vue:42:10 render` —— `.vue` 文件即出错组件;
还会从 map 内嵌的 `sourcesContent` 取出**出错行 ±3 行源码**直接展示(出错行高亮),
「复制给 AI 修复」的 markdown 同时带源码位置 + 出错源码块,列表摘要显示出错组件。
**VIP 专享**(按项目拥有者的会员判定)。

**1)云端生成上传 token**:`/app → 接入 Token → 生成`,**只勾「Sourcemap 上传」**。
这枚 token 是 CI 密钥 —— 绝不能复用 SDK init 那枚 `frontend_errors` token(它在浏览器 JS 里人人可见,
复用等于任何人都能往你的项目灌/覆盖 map)。

**2)统一生成 release**:推荐用远程 tag + 当前提交生成 `release`,格式为 `[tag]-[8位commit]`,例如
`v1.4.0-a1b2c3d4`。CI 浅克隆时先拉 tags:

```bash
git fetch origin --tags --force
npx moo-monitor-release --fetch-tags --tag-prefix v
```

**3)Vite 插件**(推荐,vite.config.ts):

```ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { mooSourcemapUpload, resolveMooRelease } from 'moo-monitor-vue/vite'

const release = await resolveMooRelease({
  fetchTags: process.env.CI === 'true', // CI 里按远程 tags 生成 release
  tagPrefix: 'v',
})

export default defineConfig({
  build: { sourcemap: 'hidden' }, // 生成 .map 但产物 JS 里不留指向注释
  define: {
    __MOO_RELEASE__: JSON.stringify(release), // SDK init 与 sourcemap 上传共用同一个值
  },
  plugins: [
    vue(),
    mooSourcemapUpload({
      endpoint: 'https://cloud.example.com/api/v1',     // 与 SDK init 相同
      token: process.env.MOO_SOURCEMAP_TOKEN!,          // CI 环境变量注入,勿入仓库
      release,
      sourceMode: 'context',                         // 'context'=源码上下文;'position'=只还原位置、不存源码
      strict: true,                                  // CI 强约束:文件齐、Debug ID 100%、无重复 ID
      archiveDir: '.moo-sourcemaps',                    // 可选:按 release/app 目录归档 map
      deleteAfterUpload: true,                          // 上传后从产物目录删 .map,不随站点发布
    }),
  ],
})
```

SDK 初始化里使用同一个构建常量:

```ts
app.use(MooMonitor, {
  endpoint: 'https://cloud.example.com/api/v1',
  token: import.meta.env.VITE_MOO_TOKEN,
  release: __MOO_RELEASE__,
  releaseCheck: import.meta.env.DEV || import.meta.env.MODE === 'staging',
})
```

TypeScript 项目可在 `src/env.d.ts` 或任意全局声明文件里补:

```ts
declare const __MOO_RELEASE__: string
```

插件选项:`include`(默认 `/\.js\.map$/`)、`sourceMode`(`context` 保留源码上下文,`position` 只还原位置)、
`strict`(CI 强约束:文件齐、Debug ID 覆盖、重复 ID 检查)、`archiveDir`(可选,按 `release/app` 目录归档 map)、
`deleteAfterUpload`(默认 `false`,生产建议 `true`)、
`failOnError`(默认 `false`:上传失败只告警不挡构建)、`injectDebugIds`(默认 `true`,见下)、`silent`。

**Debug ID(v0.3.7+,默认开启)**:插件给每个 bundle 注入唯一 ID(写进产物与 map),错误帧
携带 ID 上报,云端**优先按 ID 匹配** —— 产物与 map 内容级强绑定,与 release / 文件名 / 部署路径
解耦;传错构建批次会显式匹配失败而非错位还原。匹配链:`debug_id → (release, 文件名) → 文件名
项目内唯一回退`。因此 **release 三处一致从「硬约束」降级为「建议」**(老 SDK / curl 上传仍依赖它)。

**多 output / 多应用构建(@vitejs/plugin-legacy、monorepo)**:插件按【每个 rollup output】各跑一次上传,
`build_id` 只由本 output 的 map 文件名单哈希得出。同一 `release` + `app` 下,第二个 output(典型:legacy 链)
会以不同 `build_id` 触发云端「构建集替换」,把前一个 output(现代链)的 map 整组清掉,且 `strict` 查不出来。
**务必为每个 output / 每个应用传入不同的 `app`** 加以区分(如 `modern` / `legacy`);插件检测到同进程内
`build_id` 变化会 `warn` 提示。

**4)或裸 API**(非 Vite 项目,CI 里 curl):

```bash
curl -X POST https://cloud.example.com/api/v1/sourcemaps/intake \
  -F "token=$MOO_SOURCEMAP_TOKEN" -F "release=$APP_VERSION" \
  -F "files[]=@dist/assets/index-abc123.js.map"
```

要点:用插件 + SDK ≥0.3.7 时按 Debug ID 自动匹配(release 仅作展示);老接入按「release + 产物文件 basename」匹配,需**三处一致**;
云端默认保留最近 15 天 / 5 个 release(单文件 ≤ 20MB、单 release ≤ 50MB);错误先到、map 后上传也行,
云端会对该 release 重新还原。已传的 map 在 `/app → 设置 → Sourcemap` 查看 / 删除。
详细排查见 **[docs/sourcemaps.md](docs/sourcemaps.md)**；升级到 0.3.13 的接入步骤与验收清单见 **[docs/upgrade-0.3.13.md](docs/upgrade-0.3.13.md)**。

## 开发

```bash
npm i
npm test          # vitest
npm run typecheck  # tsc --noEmit
npm run build      # vite library 构建 → dist/(esm + cjs + d.ts)
```

## 路线图

- [x] sourcemap 上传 + 云端还原(v0.3.0:Vite 插件 + 云端流式解析,VIP)
- [ ] localStorage 持久离线队列 + 在线重放
- [ ] 性能 / Web Vitals(与异常监控正交)
- [ ] 按域名白名单的公共上报公钥

## License

MIT © charsen
