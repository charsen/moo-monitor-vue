# moo-monitor-vue v0.3.14 前端验收测试要点

> 面向:接入本 SDK 的前端同事 · 版本:v0.3.13 → v0.3.14
> 性质:内部重构 + 三处行为修正。**接入方式与配置项完全不变**(`app.use(MooMonitor, {...})`),
> 公共 API 零变化,无需改任何业务代码。

## 怎么测

用一个真实接了 axios 的 Vue 3 项目验证。测试时打开浏览器 **Network 面板**,盯住发往
`/frontend-errors/intake` 的请求体(POST body 里的 `records[]`),或直接在云端错误工作台看结果。

重点是两块:**验证三个行为修正生效** + **回归确认既有采集/上报没被重构动坏**。

---

## 一、重点验证:三个行为修正(新逻辑,务必覆盖)

### 1. `httpErrors` 现在独立于 `autoBreadcrumbs` 生效 ⭐ 最重要

- 配置 `init({ autoBreadcrumbs: false, httpErrors: { min: 400 } })`;
- 触发一个返回 **500** 的接口请求;
- **预期**:云端收到一条 `HttpError` 记录;且该记录的 `breadcrumbs` 里**没有** fetch/请求轨迹
  (因为轨迹关了)。
- 反向再测:`{ autoBreadcrumbs: true, httpErrors: false }` → 只有请求轨迹、**没有** HttpError。

> 旧版本这里是 bug:`autoBreadcrumbs: false` 会把 HTTP 错误捕获一起静默关掉。
> 若线上有这样配置的项目,升级后会开始收到 HttpError —— **属预期,不是新 bug**。

### 2. 同一个 XHR 实例复用不再重复上报

- 场景:轮询/长连接封装里**复用同一个** `XMLHttpRequest` 对象连续发多次请求
  (axios 默认每次新建,但部分手写封装或第三方 SDK 会复用);
- **预期**:每次请求只产生**一条**请求轨迹,method/URL 与该次请求一致(不会串成上一次的 URL);
  HttpError 不翻倍。
- 没有复用 XHR 的代码可跳过,属边界修复。

### 3. 隐私:登录/OAuth 回调的 token 不泄漏进轨迹 ⭐ 请重点确认

- 场景:走 OIDC/OAuth **隐式流**,回调 URL 形如
  `xxx/callback#id_token=eyJhbGci...(一长串)&access_token=...`;
- 在这个页面之后触发任意一个错误让它上报;
- **预期**:上报记录里的**导航轨迹**(`category: navigation` 的 breadcrumb)中,
  `id_token` / `access_token` / JWT 串已被打码成 `***`,**看不到明文 token**。

> 修复重点:旧版本长 token 被截断后能绕过脱敏正则。请拿真实登录流验证一遍。

---

## 二、回归确认:既有能力没被拆坏(按平时冒烟清单快速过一遍)

| 通道 | 怎么触发 | 预期 |
|---|---|---|
| JS 运行时错误 | 点一个会抛未捕获错误的按钮 | 上报,带堆栈 |
| Promise 未处理拒绝 | 触发一个没 `.catch` 的 reject | 上报 |
| Vue 组件错误 | 组件 render/生命周期里抛错 | 上报,且带**出错组件名** |
| 路由 chunk 失败 | 发版后访问旧页面懒加载 404(或手动模拟 import 失败) | 上报,且**不重复计数** |
| HTTP ≥500 | 打一个 500 接口(默认配置) | 生成 HttpError |
| 行为轨迹 | 点击/输入/切路由/发请求后再触发错误 | 轨迹含点击(带组件名)/输入(**不含内容**)/路由/请求链路 |
| 页面卸载上报 | 有残余队列时关闭/切走标签页 | 队列经 sendBeacon 发出,不丢 |
| 会话统计 | 正常使用 | 云端「影响会话数」有值 |

**拆分后最该复查的两点**:

- **点击轨迹的 Vue 组件名**仍能正确反查:点击业务组件里的按钮,轨迹显示 `· LoginForm` 这类
  **业务组件名**,而不是 `· AButton` 这种 UI 库名;
- **输入框打字绝不上报输入内容**:只记「输入 → 目标元素」,值和文本都不能出现 —— 隐私红线,务必抽查。

---

## 三、构建期(用了 sourcemap 上传的项目才需要)

- 正常跑一次 `vite build`,确认 sourcemap 上传、Debug ID 注入、云端还原都照常;
- **新增告警**(用了 `@vitejs/plugin-legacy` 等**多 output** 构建的项目注意):现在会提示
  「多 output 需按 output 区分 `app` 参数」。看到告警按提示给每个 output 配不同 `app` 即可,
  避免两次构建互相清掉对方的 sourcemap。

---

## 一句话总结

接入方式没变。重点帮忙验证 **①「关了轨迹但开着 httpErrors 时 HTTP 错误还能上报」** 和
**③「登录回调 token 不泄漏进轨迹」** 这两点;其余按平时冒烟清单过一遍即可。
