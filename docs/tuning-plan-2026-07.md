# moo-monitor-vue 架构调优方案(2026-07,rev.2)

> 执行者:Opus 4.8 · 方案作者:Fable 5(全量人读 22 个源文件 + 18 个测试文件)
> rev.2:经一轮独立对抗式复核(逐条 file:line 证伪)修订 —— 修正了 InstrumentCtx 接口缺口、
> round7 测试冲突,并把复核新发现的 3 个真问题(XHR 双计、JWT 残端绕脱敏、性能尾巴)纳入 P0。
> 基线:v0.3.13,`npm test` 129 个测试全绿,`tsc --noEmit` 干净。
> 目标版本:v0.3.14(行为修正 + 内部重构,公共 API 零变化)。

## 〇、总体结论

这不是一次「救火式」审查。项目的分层(core / vue / vite 三入口)、可靠投递设计
(字节分批、分级截断、失败回收、429 退避、卸载豁免)、隐私边界(输入控件绝不取值、
出站脱敏)都是成熟且正确的;注释里沉淀了十几轮对抗审查的「为什么」,密度罕见地高。
**本方案 = 三处行为修正(P0)+ 一次外科手术式拆分(P1)+ 测试重组(P2)+ 一批小清理(P3)。**
不要推翻任何既有设计决策。

全项目唯一的结构性问题:`src/core/client.ts` 是 525 行的「总装 + 五路插桩」共居体 ——
命令式 API、全局错误接管、点击/键盘轨迹、路由轨迹、fetch 插桩、XHR 插桩、
release 自检、卸载 flush 全在一个类里;17 个监听/补丁私有字段(7 个监听 + 10 个
orig/patched 成对)把「打补丁 → 条件还原」的生命周期摊平在类字段上,`close()` 要逐一
比对还原。新增一路插桩要改 4 个地方(字段声明 ×2、install、close)。

---

## 一、P0 行为修正(先行,每项独立小提交)

### P0.1 `autoBreadcrumbs: false` 会静默关掉 `httpErrors`

**现状**:fetch 与 XHR 的补丁都装在 `installBreadcrumbs()` 里
(`client.ts:152` 的 `if (this.opts.autoBreadcrumbs) this.installBreadcrumbs()`),
而 HttpError 的自动捕获(`httpCrumb()` → `captureException`)只能由这两个补丁触发。
于是 `init({ autoBreadcrumbs: false, httpErrors: true })` 时 HTTP 错误捕获**静默失效**,
而 README 的选项表(README.md:91、94)把两者写成互相独立的开关。

**修法**:

- 安装条件改为 `opts.autoBreadcrumbs || opts.httpErrorsMin !== null`(fetch 与 XHR 同此条件);
- 补丁内部两个动作各自独立判断:
  - 记轨迹(`fetchCrumb`)仅当 `opts.autoBreadcrumbs`;
  - 捕获 HttpError 仅当 `opts.httpErrorsMin !== null` 且状态码达阈值(现有逻辑不变);
- **callStack 采集同样加 `autoBreadcrumbs` 门**:`callStack` 的唯一消费方是
  `fetchCrumb` 的 error 级轨迹帧(client.ts:422-425),HttpError 捕获传普通对象、从不用它
  (normalize 对合成对象丢帧)。不加这道门,「只开 httpErrors」模式会给每个 fetch/XHR
  白采一次 `new Error().stack`(client.ts:256、352)——100% 纯浪费。
  即 `const callStack = skip || !opts.autoBreadcrumbs ? undefined : new Error().stack`
  (XHR 的 `meta.stack` 同理;loadend 监听本身保留,HttpError 仍需要它)。

**回归测试**(新增):`autoBreadcrumbs: false, httpErrors: { min: 400 }` 下发起一个 500 的
fetch → 断言产出一条 `HttpError` 记录、且 breadcrumbs 里**没有** fetch 轨迹;
反向:`autoBreadcrumbs: true, httpErrors: false` → 只有轨迹、无 HttpError。

**执行注记**:
- P0 之后 `autoBreadcrumbs: false` 不再等于「不碰 window.fetch/XHR」(httpErrors 默认开)。
  新回归测试与受影响的旧测试(如 client.test.ts:84 处用 `autoBreadcrumbs:false` 且不
  close 的用例)**必须 close()**,否则 `__mooPatched` 哨兵残留会污染后续用例。
- README 两处:`httpErrors` 行注明「独立于 autoBreadcrumbs 生效」;并注明
  「要完全不打 fetch/XHR 补丁,需同时 `httpErrors: false`」。

### P0.2 XHR 复用导致轨迹 / HttpError 双计 + 归因错乱(复核新发现)

**现状**:`send()` 每次调用都 `addEventListener('loadend', …)` 且无 `{ once: true }`
(client.ts:353)。同一 XHR 对象合法复用(open→send→loadend→open→send)时,第二次
loadend 触发**两个**监听:旧监听闭包持有第一次请求的 `meta`(method/url),用第二次的
status 落格 → 一次请求两条 crumb、HttpError 双计且 URL 张冠李戴。任何复用 XHR 实例的
轮询/长连接封装都会命中。

**修法**:`this.addEventListener('loadend', handler, { once: true })`。
**回归测试**:同一 XHR 实例连续两轮 open/send → 断言轨迹恰好 2 条、method/url 各自对应。

### P0.3 轨迹「先截断后脱敏」让 JWT 残端绕过 scrub(复核新发现,隐私级)

**现状**:轨迹 message 入环时截 300(breadcrumbs.ts:13)、fetch 轨迹截 280
(client.ts:411),而脱敏在**出站时**才做(normalize.ts:139)。导航轨迹带完整
location.hash(client.ts:284)—— OIDC 隐式流回调 `#id_token=eyJ…`(上千字符)被截在
JWT 中段后只剩两段,JWT 正则(scrub.ts:7 要求三段)不再命中;`id_token` 键名也不在
key=value 名单里(`\btoken\b` 因下划线是词字符,匹配不进 `id_token`)→ header+payload
(可 base64 解出用户 claims)原文出站。

**修法**(统一「先脱敏、后截断」原则,两处):
- `BreadcrumbBuffer.add`:先 `scrub(message)` 再截 300;
- `client.fetchCrumb`:key 先 scrub 再截 280;
- 顺手把 `id_token`、`jwt` 加进 scrub.ts 的键名单(防其他截断路径的残端);
- normalize 出站的 scrub **保留**(scrub 幂等,双跑无害,仍是深度防御兜底)。

**回归测试**:导航到 `#id_token=<三段长 JWT>` 后触发错误 → 上报记录的导航 crumb 里
不含 JWT payload 段(`***` 已打码)。

---

## 二、P1 拆分 client.ts(核心调优)

### 2.1 约定:插桩模块统一签名

```ts
// src/core/instrument/types.ts
export type Uninstall = () => void

/** 插桩模块与总装之间的窄接口 —— 模块绝不反向 import client。 */
export interface InstrumentCtx {
  opts: ResolvedOptions
  intakeUrl: string
  crumb(b: Breadcrumb): void                              // → client.addBreadcrumb
  /** 最近一条轨迹的【活引用】—— httpCrumbs 的「×N」原地折叠必需(见 breadcrumbs.ts:22-25 的刻意设计)。 */
  lastCrumb(): Breadcrumb | undefined                     // → crumbs.last()
  capture(input: unknown, hint?: CaptureHint): void       // → client.captureException
  flush(useBeacon: boolean): boolean                      // → client.flush(flushOnHide 用)
  onError(e: unknown): void                               // → opts.onError(SDK 自身错误)
}
```

每个模块导出 `install(ctx: InstrumentCtx): Uninstall`:
- 补丁的 `orig/patched` 引用、哨兵检查、「仅当补丁仍是自己打的才还原」逻辑
  全部内聚在模块闭包里 —— **这三条语义一条都不能丢**(`__mooPatched` 防重复叠包、
  按引用条件还原防覆盖他人补丁,都是踩过坑的设计);
- 模块内私有状态(打字聚合的 `lastInputEl`、fetch 折叠的 `lastFetch`、popstate 的
  `lastPath`)随之变成闭包变量,`uninstall` 时置空。

### 2.2 目标文件布局与迁移映射

| 新文件 | 从 client.ts 迁入 | 预估行数 |
|---|---|---|
| `src/core/instrument/types.ts` | (新增,上述约定) | ~25 |
| `src/core/instrument/globalErrors.ts` | `installGlobalHandlers`(onerror + unhandledrejection,含 SVG href / `__mooSeen` 逻辑;`__mooSeen` 是与 vue/plugin.ts:35 的错误对象属性契约,不是模块态,原样保留) | ~50 |
| `src/core/instrument/domCrumbs.ts` | click + keydown 手柄 + `describeWithComponent`(click 会重置 keydown 的打字聚合态 `lastInputEl`,二者共享状态,必须同居) | ~60 |
| `src/core/instrument/historyCrumbs.ts` | `installNavigationBreadcrumbs`(pushState/replaceState/popstate,`lastPath` 内聚) | ~50 |
| `src/core/instrument/httpCrumbs.ts` | fetch 补丁 + `installXhrBreadcrumbs` + `httpCrumb` + `fetchCrumb` + `callerFrames` + `isIgnoredFetchUrl` —— fetch/XHR 共享折叠状态与落格逻辑,**必须同居一个模块**;折叠经 `ctx.lastCrumb()` 实现 | ~180 |
| `src/core/instrument/flushOnHide.ts` | `installFlushOnHide`(visibilitychange + pagehide,经 `ctx.flush`) | ~25 |
| `src/core/releaseCheck.ts` | `checkSourcemapRelease`(只需 opts + onError) | ~40 |

拆分后的 `client.ts`(目标 ≤ 220 行)只剩:

- 构造(resolveOptions、Queue、BreadcrumbBuffer、intakeUrl);
- 命令式 API(captureException / captureMessage / setUser / setTag / setExtra /
  addBreadcrumb / flush)—— capture 管道(session 注入 → normalize → ignore →
  sample → beforeSend → queue)原样保留;
- `install()`:按开关把各模块的 `Uninstall` 收进 `private uninstallers: Uninstall[]`;
  **每个模块的 install 各自 try/catch**(现在是一个 try 包四步,client.ts:150-157,
  releaseCheck 挪到第一位后若同步抛错会连坐全部插桩 —— 逐模块包,与 close 对称);
- `close()`:`flush(true)` → 遍历 `uninstallers`(逐个 try/catch,单个失败不阻断
  其余还原)→ `enabled = false`(这是「补丁无法还原时靠 captureException 门禁兜底」
  的安全网,client.ts:61,必须保留);
- 模块级单例(init/getClient + 便捷导出)不动。

17 个监听/补丁私有字段全部消失。

### 2.3 releaseCheck 的顺序调整(消除跨模块引用)

现状 `checkSourcemapRelease` 用 `this.origFetch ?? window.fetch`(client.ts:475)绕过
补丁,依赖「installBreadcrumbs 先跑、origFetch 已存」的隐式顺序。拆分后改为:
**`install()` 里先调 releaseCheck、后装 httpCrumbs** —— releaseCheck 在同一 tick
同步取 `window.fetch` 并 `bind(window)` 发出请求,此刻本实例必未打补丁
(若环境里残留他人补丁,行为与现状全等 —— 现状的 `?? window.fetch` 分支取到的
也是同一个引用),不再需要跨模块拿 origFetch。已核验四种情形(已打补丁 / 未打 /
他人补丁在前 / 重复 init)下引用一致,零行为变化。

### 2.4 硬性约束

1. **注释随代码走**:所有中文「为什么」注释是十几轮审查的知识沉淀,迁移时逐段带走,
   一句不丢;只允许改注释里的行号/文件名指向。
2. **不引入新抽象**:除 `Uninstall`/`InstrumentCtx` 外,不加事件总线、不加 DI 容器、
   不加基类继承。ctx 就是一个朴素对象。
3. **公共 API 零变化**:三个入口(`.`、`/vue`、`/vite`)的导出集合、类型签名不变;
   `dist/index.d.ts` 顶层导出 diff 为空(新增 instrument/ 内部 d.ts 文件是允许的)。
4. **每迁一个模块一个 commit**,commit 内 `npm test` 必须全绿。
5. **`function(this: …)` 补丁绝不能改成箭头函数**:history wrap(client.ts:299)、
   XHR open/send(client.ts:338、348)依赖调用方 this,迁移时保持 function 形态。
6. **round7-fixes ⑤ 的私有字段断言豁免**:round7-fixes.test.ts:129-138 直接断言
   `(client as any).lastInputEl` 私有字段,P1 拆分后字段消失、该测试必红。
   允许(且必须)在对应迁移 commit 内把它改写为**可观测行为断言**
   (如 close 后再触发 keydown / fetch 不新增轨迹)。P2 的「断言逐条保留」红线
   对此测试豁免 —— 这是全项目唯一允许改写的既有断言。

---

## 三、P2 测试按模块重组(P1 完成后做)

现状:`round7-fixes` / `round8-fixes` / `round9-fixes` / `capture-chain` /
`delivery-hardening` 按「审查轮次」组织,单个文件横跨 Queue、normalize、uaParse、
vue 插件、vite 插件多个模块 —— 「queue 的截断行为测在哪」要翻三个文件才知道。
轮次命名只对经历过那几轮审查的人有意义。

**做法**:把上述 5 个轮次文件里的用例**原样搬**进对应模块文件
(client.test.ts / queue.test.ts / transport.test.ts / normalize.test.ts /
scope.test.ts / vue.test.ts / vite-plugin.test.ts / uaParse.test.ts…),
describe 名保留原有的中文场景描述(如「卸载豁免退避」),
可在 describe 注释里保留「源自第 N 轮审查」的出处一句话。

**红线**:只移动、不改写、不删除(唯一例外见 2.4 第 6 条);重组前后用例总数一致
(129 + P0 新增),断言逐条保留。每搬空一个轮次文件删除之,一个 commit。

---

## 四、P3 小清理(顺手,各自独立小 commit)

1. **normalize.ts:125** — `message: scrub(message) ?? message` 中 `?? message` 是死代码
   (`scrub<T>` 对 string 入参恒返回 string:空串走 `if (!v) return v` 原样返回,
   非空走 replace 链),删掉 `?? message`。
2. **dom.ts:23** — `isEditable` 是 `isInputLike` 的纯转发包装,合并为一个:
   `isInputLike` 更名为 `isEditable`(保留导出名),`hintOf`(dom.ts:76)改调它。
3. **types.ts:170** — `httpErrorsMin` 的嵌套三元链展开成小函数
   `resolveHttpErrorsMin(o.httpErrors)`。**三处隐藏语义必须保持**:
   ① `o.httpErrors == null` 是**宽松等于**(同时盖 null/undefined),不得写成 `=== undefined`;
   ② `{}`(空对象)→ 先取默认 500 再钳,结果是 **500 而非 400**,
     钳制必须保持 `Math.max(min ?? 500, 400)` 的顺序;
   ③ 类型外输入 `httpErrors: 0` 走对象分支取 `.min` 得 undefined → 500,不抛错。
   现有测试只覆盖 `{min:0}`/`{min:404}`(capture-chain.test.ts:221-222),
   **顺手补一条 `{}` → 500 的断言**。
4. **queue.ts 失败回收顺序(可选)** — 两处顺序反转:① sendBatch 多批「未派发」时逐批
   `unshift`(queue.ts:166)→ 批间反转;② `recover()` 正序逐条 `unshift(r)`
   (queue.ts:198-205)→ 批内反转([r1,r2,r3] 回收后变 [r3,r2,r1])。
   影响均可忽略(云端按 hash 聚合、时间取自记录本身)。**要修一起修**
   (失败批攒局部数组一次性回插 / recover 倒序回插),不修则两处各补一行注释说明。
5. **vite/plugin.ts — 多输出构建互清构建集(告警,不改行为)** — `writeBundle` 每个
   rollup output 各跑一次,`buildId` 只由本 output 的 map 文件名哈希(plugin.ts:229);
   同 release+app 下第二个 output(典型:@vitejs/plugin-legacy)以不同 build_id 触发
   云端「构建集替换」,把现代链的 map 整组清掉,且 strict 查不出来(expected_files 按
   本 output 计)。**修法**:插件闭包记录首个 buildId,同进程二次 writeBundle 且
   buildId 不同时 `warn` 提示「多 output 构建须按 output 区分 app 参数」;README 补一节。
6. **vite/plugin.ts — 子目录产物 basename 冲突(告警,不改行为)** — 上传与归档都只取
   `basename(name)`(plugin.ts:317、235),自定义 `entryFileNames` 产出不同目录同名
   map 时归档互相覆盖、云端匹配二义。**修法**:上传前检测 basename 冲突,命中即 `warn`
   (debug_id 可救栈匹配,救不了归档丢失)。
7. **README — injectDebugIds 已知限制一条**:writeBundle 阶段改写 JS(plugin.ts:139-146),
   与在 generateBundle 阶段计算 SRI 完整性哈希的插件(vite-plugin-sri 等)冲突,
   会导致浏览器拒载全部 chunk;两者不可同时启用。

---

## 五、明确不做(防 scope creep)

以下项**禁止**在本轮实施 —— 有的是已被推翻过的方案,有的是另立项的功能:

- ❌ 跨 flush 的客户端去重(queue.ts 注释已解释:TTL/定时器复杂度反复引 bug,收益边际);
- ❌ 指纹算法、hash 位宽、云端协议字段的任何改动;
- ❌ transport 的模块级退避状态改成实例级(跨实例共享退避是「保护云端入口」的刻意设计);
- ❌ SSR per-request 多实例支持:模块级单例在 Nuxt 式「每请求 createApp」下会跨请求
  串态(请求 B 的 init 会 close 请求 A 的 client),这是已知边界 —— 本轮只在 README
  的 SSR 说明里加一句「服务端为进程级单例,并发请求请勿依赖 setUser 隔离」,
  重新设计留 roadmap;
- ❌ 新功能:console.error 轨迹通道、HarmonyOS/华为浏览器 UA 识别、错误分级采样
  ——这些可进 roadmap,不属于本次重构;
- ❌ 更换构建工具、拆包发布、引入运行时依赖(零依赖是立项卖点)。

---

## 六、执行守则与验收

**提交序列**(严格按序,每步全绿再走下一步):

1. P0.1 / P0.2 / P0.3 各一 commit(修正 + 回归测试 + README 对应行);
2. P1 逐模块拆分(instrument/types → globalErrors → domCrumbs → historyCrumbs
   → httpCrumbs → flushOnHide → releaseCheck → client 收尾瘦身),每模块一 commit;
3. P3 七项小清理;
4. P2 测试重组,每搬空一个轮次文件一 commit;
5. CHANGELOG 补一节 v0.3.14。

**每步验收**:`npm run typecheck && npm run lint && npm test`。

**最终验收**:

```bash
npm run typecheck && npm run lint && npm test   # 全绿,用例数 ≥ 133(129 + P0 三项 + P3.3)
npm run build                                    # 成功
# 1) 公共 API 不变:对比重构前后 dist/index.d.ts、dist/vue/index.d.ts 顶层导出集合;
# 2) 体积不膨胀:dist/index.js 与 dist/vue.js 字节数与基线差 < 3%;
# 3) 冒烟:node -e "import('./dist/index.js').then(m => console.log(Object.keys(m)))"
#    输出与基线一致(init/getClient/captureException/… 全在)。
```

**基线数据**(重构前采集,供对比):v0.3.13,129 tests,`client.ts` 525 行 /
私有字段 26 个(其中监听/补丁字段 17 个);重构后 `client.ts` ≤ 220 行、
监听/补丁类私有字段 0 个(仅剩 opts/intakeUrl/queue/crumbs/scope/installed/uninstallers)。
