# moo-monitor-vue 项目说明(研发立项)

> 版本基线:v0.3.12 · 2026-06 · 仓库:https://gitee.com/charsen/moo-monitor-vue

## 一句话介绍

**moo-monitor-vue 是一个自研的轻量级 Vue 3 前端异常监控 SDK:在用户浏览器里捕获 JS 错误与出错前的操作链路,可靠上报到自有云端(moo-scaffold-cloud),并通过构建插件实现压缩代码到源码位置的自动还原 —— 对标 Sentry 浏览器 SDK 的核心能力,零第三方依赖,数据完全自主。**

## 立项背景与价值

- **问题**:线上前端报错长期处于黑盒状态 —— 用户说「点了没反应」,研发只能凭猜复现;接入商业方案(Sentry 等)存在数据出境/出企、按量计费、与内部告警体系割裂三个问题。
- **方案**:自研 SDK + 自有云端闭环。错误数据落在自己的服务器,与内部已有的运行时/慢 SQL 监控、钉钉/企微告警共用一套项目、token、通知管道。
- **量化特征**:零运行时依赖;浏览器包 gzip 约 12KB;接入成本一行 `app.use(MooMonitor, {...})`;126 个自动化测试,经十余轮对抗式代码审查。

## 总体架构

```
宿主 Vue 应用(浏览器)
 ├─ 捕获层:onerror / unhandledrejection / Vue errorHandler / Router / fetch ≥500 / 手动
 ├─ 轨迹层:点击(带 Vue 组件名)· 键盘 · 路由 · 请求(fetch + XHR/axios;环形 30 条,出错时随错误带出)
 ├─ 归一层:任意抛掷物 → 标准记录(栈解析 / 脱敏 / 稳定指纹)
 ├─ 队列层:同指纹合并计数 → 字节分批 → 截断分级
 └─ 传输层:fetch(常态)/ sendBeacon(页面卸载),429 退避 + 失败回收
        │  POST {token, records[]}
        ▼
moo-scaffold-cloud(自有云端)
 ├─ 入库:服务端重算指纹防投毒、按 (项目,指纹) 聚合累计、影响会话数统计
 ├─ 还原:Debug ID / 文件名三级匹配 sourcemap,压缩堆栈 → 源码位置 + 出错行源码
 └─ 消费:错误工作台(链路时间线/趋势/三诊)、钉钉企微邮件告警、「复制给 AI 修复」

构建期(CI 或本地打包)
 └─ Vite 插件:给每个 bundle 注入 Debug ID → 自动上传 .map(构建集替换,多应用分桶)→ 可选清除产物中的 .map
```

## 分模块介绍

包内三个发布入口,职责互不交叉:

| 入口 | 运行环境 | 职责 |
|---|---|---|
| `moo-monitor-vue`(core) | 浏览器 | 框架无关的采集/上报内核,可用于任意 JS 项目 |
| `moo-monitor-vue/vue` | 浏览器 | Vue 3 适配薄层(插件、errorHandler 接管、依赖注入) |
| `moo-monitor-vue/vite` | Node(构建期) | sourcemap 上传 + Debug ID 注入 + CI 健康检查插件,不进浏览器包 |

### core 内核(src/core,~1300 行)

| 模块 | 职责 |
|---|---|
| `client.ts` | 总装:生命周期(init/close)、自动捕获安装、行为轨迹手柄(fetch + XHR 插桩)、HTTP 错误捕获、会话注入 |
| `normalize.ts` | 任意抛掷物 → 标准上报记录;栈解析调度;稳定指纹(剥离构建 hash) |
| `stacktrace.ts` | Chrome/Firefox/Safari/eval/native/无列号 六类栈格式解析 |
| `queue.ts` | 内存批量队列:同指纹合并、UTF-8 真字节分批(≤56KB)、分级截断、失败回收 |
| `transport.ts` | 发送通道:fetch / sendBeacon、429 Retry-After 退避、失败分类回调 |
| `scrub.ts` | 出站脱敏(token=/JWT/Bearer/敏感 key-value) |
| `breadcrumbs.ts` | 行为轨迹环形队列(30 条,message 钳 300) |
| `dom.ts` | 操作元素解析:就近交互祖先 + 可读描述 + Vue 业务组件名反查(跳过 UI 库组件),输入控件绝不取值 |
| `session.ts` | 会话 ID 自动化(sessionStorage,标签页生命周期) |
| `debugIds.ts` | Debug ID 注册表读取,栈帧携带 ID 上报 |
| `scope.ts` | 用户/tags/extra 上下文(均有钳制) |
| `sampling.ts` / `hash.ts` / `uaParse.ts` | 采样与噪音过滤 / FNV-1a 指纹 / UA 解析(含微信、钉钉、QQ、UC、iOS 三方浏览器) |

### vue 适配层(src/vue)

接管 `app.config.errorHandler`(保留宿主原 handler)、提取出错组件名(兼容 `<script setup>`)、接 `router.onError` 捕获发版后旧 chunk 404、防同一错误双计、SSR 安全、`provide/$moo` 依赖注入。

### vite 插件(src/vite)

构建结束自动执行:Debug ID 注入(见功能点)→ 可选剥离 `sourcesContent` → 收集 `.map` 分批上传(条数 + 字节双重分块,避开服务器上传限制)→ 校验云端 health → 可选删除产物中的 `.map` 并清理指向注释。429 自动重试、中途失败给出半传摘要、成功日志注明还原生效时间。携带确定性构建集标识与多应用标识(`app`):同版本重复构建自动整组替换旧工件(不堆积),monorepo 多应用互不干扰。

## 功能点清单

### 1. 错误采集(六个通道,不漏报)

| 功能点 | 介绍 |
|---|---|
| 全局 JS 错误捕获 | `window.onerror` 捕获阶段监听,带完整堆栈;无 Error 对象时用事件位置补帧 |
| 未处理 Promise 拒绝 | `unhandledrejection`,任意抛掷物(字符串/对象/循环引用)安全归一 |
| Vue 组件错误 | 渲染/生命周期/watcher 错误被 Vue 吞掉、不冒泡到 onerror,单独接管并附**出错组件名** |
| 路由 chunk 失败 | 发版后旧页面懒加载 404(最常见的"白屏"原因),经 `router.onError` 捕获,且与 Promise 通道防双计 |
| HTTP 响应错误 | 经包裹的 **fetch 与 XMLHttpRequest(axios)**,状态码 ≥500 自动生成错误(阈值可调/可关);URL 去 query 进指纹,轮询不会刷爆配额 |
| 资源加载失败 / 手动上报 | img/script/css 404 记为告警级;`captureException/captureMessage` 供业务主动上报 |

### 2. 操作链路(回答「用户做了什么才报错」)

| 功能点 | 介绍 |
|---|---|
| 点击轨迹 | document 级监听,解析到就近交互元素(点中按钮内的图标也归到按钮)并标注**所属 Vue 业务组件**(自动跳过 AInput 等 UI 库组件),产出 `button#checkout "去结算" · LoginForm` 级别的可读描述 |
| 键盘轨迹 | 只记 Enter/Escape 关键节点与「开始在某输入框打字」事件;**按键值/输入内容/密码一概不采** |
| 路由轨迹 | SPA 跳转记 `from → to`(history 与 hash 路由均支持) |
| 请求轨迹 | fetch 与 XHR(axios)统一覆盖;method/URL/状态码;连续同一请求(轮询)折叠为「×N」;第三方统计域名(GA/百度统计/友盟等)默认过滤不刷屏 |
| 失败请求溯源 | 失败请求自动携带发起方调用帧,云端经 sourcemap 还原为「发起于 src/api/login.ts:42」(自动避开 request 封装层与依赖库) |
| 云端时间线 | 配套云端把轨迹渲染成带图标、相对时间(「报错前 3.2s」)、💥 锚点的操作链路 |

### 3. 上下文与统计

| 功能点 | 介绍 |
|---|---|
| 会话自动化 | 自动生成会话 ID(标签页生命周期),云端据此统计**「影响会话数」**——区分「一人刷了 50 次」与「50 人各炸一次」 |
| 用户/标签/附加数据 | `setUser/setTag/setExtra`,均有大小钳制,防业务误塞大对象拖垮上报 |
| 环境信息 | 环境/版本/浏览器+版本/系统/设备类型;UA 解析覆盖微信、钉钉、QQ、UC 内嵌与 iOS 三方浏览器 |

### 4. 聚合与指纹(同类错误一条记录)

| 功能点 | 介绍 |
|---|---|
| 稳定指纹 | 错误类型 + 归一化消息 + 栈顶帧;**剥离构建产物的内容 hash 段**,发版后不会全量「误报新错误」 |
| 客户端合并 | 上报窗口内同指纹合并累计次数,错误风暴不刷网络;现场字段取最新一次发生 |
| 服务端防投毒 | 云端忽略客户端指纹、自行重算 —— 恶意客户端无法刷爆配额或强行归并 |

### 5. 可靠投递(弱网/限流/页面关闭都不丢)

| 功能点 | 介绍 |
|---|---|
| 批量与体积控制 | 条数 + UTF-8 真字节双重分批(≤56KB),避开浏览器发送通道的 64KB 静默丢弃 |
| 分级截断 | 超大记录先丢附加数据、再丢轨迹/栈、仍超则丢弃并计数 —— 绝不静默 |
| 限流退避 | 云端 429 时按 Retry-After 退避;被拒批次回收重试一次,语义拒绝(413/422)可感知地丢弃 |
| 页面卸载兜底 | `sendBeacon` 发出残余队列(豁免退避 —— 此刻不发就没机会了) |
| 降噪开关 | `sampleRate` 采样、`ignoreErrors` 噪音过滤、`beforeSend` 改写/拦截、`onError` 自身错误回执 |

### 6. 隐私与安全(默认安全,无需配置)

| 功能点 | 介绍 |
|---|---|
| 出站脱敏 | 消息/堆栈/URL/轨迹中的 `token=`、JWT、`Bearer`、敏感 key-value 在**离开浏览器前**打码;云端写入/读取再各兜一层 |
| 输入内容零采集 | 键盘只记事件不记值;输入控件的描述只用 name/placeholder/type |
| 凭证安全 | 不带 cookie(`credentials: omit`);token 走请求体、无自定义头(免 CORS 预检);浏览器 token 与上传 token 强制隔离 |

### 7. Sourcemap 还原与 Debug ID(压缩堆栈 → 源码)

| 功能点 | 介绍 |
|---|---|
| 构建端自动上传 | Vite 插件在构建结束收集 `.map` 上传云端;**生产站点无需部署 .map**(可自动删除并清理指向注释) |
| Debug ID 注入 | 给每个 bundle 注入内容派生的唯一 ID(对标 Sentry):产物与 map 内容级强绑定,匹配与 release/文件名/部署路径解耦;传错构建批次会显式失败而非错位还原 |
| CI 健康检查 | 上传响应返回 release health;`strict: true` 要求文件齐、Debug ID 覆盖 100%、无重复 ID,不达标直接挡构建 |
| 源码安全模式 | `sourceMode: 'context'` 展示源码上下文;`position` 在上传/归档前剥离 `sourcesContent`,只还原文件/行/列 |
| 运行时自检 | SDK 可开启 `releaseCheck`,用浏览器 token 只读检查该 release 是否已有 map、Debug ID 覆盖是否正常 |
| 三级匹配链 | Debug ID 直查 → (release, 文件名) 精确 → 文件名项目内唯一回退;老接入与 curl 上传完全兼容 |
| 构建集管理 | 同版本重复构建自动整组替换旧工件(不堆积、配额不被旧文件占满);保留上一构建集 72h 兜底灰度/回滚窗口;monorepo 多应用按 app 分桶互不干扰 |
| 云端还原 | 零依赖流式 Source Map 解析(大 map 不爆内存),还原出 `.vue` 源文件(即出错组件)+ 出错行 ±3 行源码,喂给「复制给 AI 修复」 |

### 8. 工程质量

| 功能点 | 介绍 |
|---|---|
| 零运行时依赖 | 无任何第三方 npm 依赖进入浏览器;Vue 为可选 peer,核心可用于任意 JS 项目 |
| 体积 | 浏览器包 gzip ≈ 12KB(Sentry browser SDK 约 25KB+) |
| 微前端/HMR 友好 | `close()` 完整还原所有补丁与监听器;重复 init 自动收尾,不泄漏不重复上报 |
| SSR 安全 | 服务端渲染下命令式 API 可用且全部安全 no-op |
| 质量门禁 | TypeScript strict、ESLint、126 个自动化测试、发布前自动校验;v0.2~v0.3 共经十余轮对抗式审查(并发、内存、隐私、协议多视角) |

## 边界(刻意不做)

性能指标(Web Vitals)、页面录屏回放、正常业务请求采集、本地持久化离线队列 —— 前三者与异常监控正交且涉及更重的性能/隐私代价,离线队列经评估属高风险低收益,均不在本项目范围。

## 配套依赖

- **moo-scaffold-cloud**(自有云端,同团队维护):错误工作台、聚合入库、sourcemap 还原、入站过滤、AI 辅助降噪、钉钉/企微/邮件告警。SDK 不可独立产生价值,立项范围默认含云端前端错误管道的持续维护。
- 浏览器要求:现代浏览器(ES2020);构建插件要求 Node ≥18、Vite。
