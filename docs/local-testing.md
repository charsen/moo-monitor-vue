# 发布到 npm 之前,如何安装 moo-monitor-vue 测试

> `moo-monitor-vue` 暂未发布到 npm(`npm i moo-monitor-vue` 现在装不到)。
> 在正式发布前,用下面任意一种方式从 **gitee 源码**安装到你的 Vue 3 项目里测试。

仓库:<https://gitee.com/charsen/moo-monitor-vue>

## 前提

- Node ≥ 18(`node -v` 确认)。
- 你的项目是 **Vue 3**(SDK 把 `vue` 当 peer 依赖,用你项目里的 vue)。
- 安装时 SDK 会自动构建产物(`prepare` 脚本会跑 `vite build`),**无需手动 build**。

---

## 方法一:直接从 gitee git 安装(推荐给测试同事,最省事)

在你的项目根目录:

```bash
npm i git+https://gitee.com/charsen/moo-monitor-vue.git
```

- 指定分支 / tag:在末尾加 `#master`(或某个 tag,如 `#v0.2.0`)。
- 用 pnpm / yarn 同理:
  ```bash
  pnpm add git+https://gitee.com/charsen/moo-monitor-vue.git
  yarn add git+https://gitee.com/charsen/moo-monitor-vue.git
  ```
- 装完 `package.json` 里会出现:
  ```jsonc
  "dependencies": { "moo-monitor-vue": "git+https://gitee.com/charsen/moo-monitor-vue.git" }
  ```

> 走 SSH 也行(若你配了 gitee SSH key):`npm i git+ssh://git@gitee.com/charsen/moo-monitor-vue.git`

> ⚠️ 从 git 安装时会自动构建(`prepare` 跑 `vite build`,需要 devDependencies)。所以**别用 `--omit=dev` / `--production` 安装**(会因缺 vite 等构建依赖而失败)。普通 `npm i`(默认装 devDependencies)即可;若你的环境强制生产安装,改用下面的「方法二:tarball」(tarball 内已是构建好的 `dist`,安装时不再构建)。

---

## 方法二:打 tarball 再安装(最贴近"正式发布的样子")

适合想验证"将来 `npm publish` 出来的包"是否正确的人。

```bash
# 1) 在 SDK 仓库里打包(会自动 build,产出 .tgz)
git clone https://gitee.com/charsen/moo-monitor-vue.git
cd moo-monitor-vue && npm install && npm pack
# → 生成 moo-monitor-vue-0.2.0.tgz

# 2) 在你的项目里安装这个 tarball
npm i /绝对路径/moo-monitor-vue/moo-monitor-vue-0.2.0.tgz
```

装进去的就是 `files` 白名单内容(`dist` + README + LICENSE),和将来发布到 npm 的产物一致。

---

## 方法三:本地联调(边改 SDK 边测,适合参与开发的人)

```bash
# A. file: 协议
npm i file:/绝对路径/moo-monitor-vue

# B. npm link
cd /绝对路径/moo-monitor-vue && npm install && npm run build && npm link
cd 你的项目 && npm link moo-monitor-vue
```

> ⚠️ link / file 联调时,你的项目和 SDK 可能各装一份 vue,偶发 **"You are running multiple copies of Vue"** 告警。
> 解决:在你项目的 `vite.config.ts` 加
> ```ts
> resolve: { dedupe: ['vue'] }
> ```

---

## 接入代码(任意安装方式后都一样)

```ts
// main.ts
import { createApp } from 'vue'
import App from './App.vue'
import MooMonitor from 'moo-monitor-vue/vue'

const app = createApp(App)

app.use(MooMonitor, {
  endpoint: import.meta.env.VITE_MOO_ENDPOINT, // 云端 /api/v1 基址
  token: import.meta.env.VITE_MOO_TOKEN,       // 勾了「前端错误上报」的项目 token
  env: import.meta.env.MODE,                   // development / production
  release: 'test-1',                            // 版本号,随意填一个便于区分
  // 本地测试想每条都发、不被环境过滤,可让云端规则 env_filter 留空,或把 env 设成 production
})

app.mount('#app')

// 命令式上报(可选):
// import { captureException, setUser } from 'moo-monitor-vue'
// setUser({ id: 1, name: '测试同学' })
// try { JSON.parse('{bad') } catch (e) { captureException(e) }
```

`.env.local` 示例:

```
VITE_MOO_ENDPOINT=http://127.0.0.1:8000/api/v1
VITE_MOO_TOKEN=粘贴你的项目 token
```

---

## 云端准备(拿 token)

1. 登录云端(Moo Scaffold Cloud)→ 进你的项目 → **设置 → 接入 Token → 生成**。
2. 权限勾选 **「前端错误上报 (Vue SDK)」**,生成后**完整 token 只显示一次**,复制好。
3. 把 `endpoint`(`http://<云端地址>/api/v1`)和 `token` 配进上面的 `.env.local`。

---

## 验证闭环(3 步看到数据)

1. 启动你的 Vue 项目(`npm run dev`)。
2. 在页面上**故意抛个错**:
   ```ts
   throw new Error('hello moo monitor')
   // 或点一个会报错的按钮 / 调一个会 404 的接口
   ```
3. 几秒后(SDK 默认每 5s 批量上报,或刷新 / 切到后台会立刻发),到云端
   **项目 → 数据 → 「前端错误」** 列表查看,应能看到这条 `Error: hello moo monitor`,
   点开有调用栈、浏览器、breadcrumbs 等。

> 想立刻发不等 5s:把配置加 `flushInterval: 1000`,或切走标签页触发 `pagehide` flush。

---

## 看不到数据?排查清单

- **token 权限不对**:必须勾了「前端错误上报」。权限不符服务端返回 403。
- **被环境过滤**:云端 `frontend_error` 规则默认只在 `production` 推送/统计;本地把 `env` 设成 `production`,或去云端「通知规则」把该规则的环境过滤留空。(注:列表展示不受 env 影响,**通知**才受)。
- **endpoint 写错**:应以 `/api/v1` 结尾,SDK 内部自动拼 `/frontend-errors/intake`。
- **跨域 / 混合内容**:HTTPS 页面调 HTTP 云端会被浏览器拦;本地 `http://` 页面调 `http://127.0.0.1:8000` 没问题。
- **被噪音过滤**:检查有没有设 `ignoreErrors` 把你的测试错误匹配掉了。
- **F12 看网络**:应有一条 `POST .../frontend-errors/intake`(或 sendBeacon),返回 `{ ok: true, saved: 1 }`。
  - 返回 401/403 → token 问题;429 → 触发限流(测试期把云端 `INTAKE_RATE_LIMIT_PER_MIN` 调大)。

---

## 更新到最新

从 git 安装的依赖不会自动更新,SDK 有新提交时重新装一次:

```bash
npm i git+https://gitee.com/charsen/moo-monitor-vue.git   # 重新拉最新 master
```
