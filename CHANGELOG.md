# Changelog

## 0.3.5

第八轮对抗审查 —— 修复 6 个问题:

1. **缓冲满丢「最新」留「最旧」**:长退避/断网后保住的是 200 条最旧记录,当前正在发生的
   反而被丢 —— 改为挤掉最旧、收下最新(丢弃仍经 onDrop 可感知)。
2. **超大记录截断兜不住且照发**:page.url/referrer(超长 query/OAuth state)不在裁剪
   范围;两轮截断后仍超限的记录原样发出,卸载路径被 beacon 64KB 静默吃掉。
   url/referrer 纳入一轮裁剪(2048,与云端同口径);仍超限 → 丢弃计数,不再装作发了。
3. **hash 路由零导航轨迹**:createWebHashHistory 的跳转只改 location.hash,
   路径计算不含 hash → to===from 全部被吞。路径纳入 hash。
4. **breadcrumb message 无界**:fetch('data:…巨串') / 超长 query 的单条 crumb 数十 KB,
   把每条记录顶到截断线(届时整组轨迹被丢)。入队即钳 300(fetch 折叠路径同步钳)。
5. **Vite 插件失败处理**:429 等 2s 重试一次;错误信息兼容 Laravel 框架级 message 字段
   (此前 429/异常页只打出裸 "HTTP 429");中途失败给出「已传 N/共 M,release 部分上传,
   重跑构建可补齐」摘要,不再一句裸告警就半途而废。
6. **无列号匿名帧解析成垃圾**:"at file:line"(无列号)落进 native 兜底,整个 URL 被当成
   函数名、file 丢失,污染指纹。新增 CHROME_NOCOL 模式正确解析。

- 测试 +7,102 passed。

## 0.3.4

第七轮对抗审查 —— 修复 6 个问题:

1. **captureMessage / 资源加载错误自带 SDK 内部栈**:SDK 里 new 出来的 Error 栈全是监控
   代码自己,被当成出错位置且污染指纹。改传普通对象走合成栈路径(帧被丢弃),
   name 也更语义化:`Message` / `ResourceError`(可按名过滤)。
2. **指纹跨发版不稳定**:产物文件名带构建内容 hash(`index-DfA3k2Lz.js`),每次发版
   全部错误换指纹 → 全量重新分组、首见(NEW)告警风暴、趋势/影响会话统计断裂。
   指纹改用剥离 hash 段的稳定文件名(8~16 位段长,避开 -legacy/.min 语义后缀);
   **云端 serverHash 同步修改(需配套部署),已有错误行的指纹会一次性轮换**。
3. **iOS 上的 Chrome / Firefox 误判成 Safari**:CriOS / FxiOS UA 不含 Chrome//Firefox/,
   此前落到 Safari 分支 —— 移动端浏览器分布统计失真。
4. **Vue Router 错误双重捕获**:router.onError 捕获的同一个 Error 还会沿未 catch 的
   push() 拒绝进 unhandledrejection → count 翻倍。插件捕获前打标(errorHandler 同),
   rejection 手柄认标跳过(frozen 对象打不上标时退回双计,绝不抛错)。
5. **重试记账与生命周期**:回收重试中的记录与新发生合并后是新对象,「已重试」标记
   丢失 → 持续故障期间可无限重试,改为标记随合并延续;close() 清空
   lastInputEl/lastFetch(微前端卸载不再滞留已脱离的 DOM 节点)。
6. **setTag 值无界**:tags 随每条记录上报,一个超长值会把所有记录顶到截断线
   (挤掉 stack/轨迹)。key 钳 64、value 钳 200。

- 测试 +8(逐问题回归),95 passed。

## 0.3.3

第六轮对抗审查(可靠投递专项)—— 修复 6 个问题:

1. **多批 flush 静默丢数据**:keepalive/sendBeacon 的 64KB 是「全部在途请求共享」的配额,
   一次 flush 同步派出 ≥2 批时第二批起整批被吃且无信号。常态周期改用普通 fetch
   (不带 keepalive),仅页面卸载路径保留 beacon/keepalive。
2. **429 吃掉触发批 + 非 429 失败不可见**:记录先出队后发送,响应在异步 then 里无人接盘。
   transport 新增 onFail 失败回收:429(已设退避)/网络错/5xx 回收进缓冲重试一次,
   二次失败丢弃并计入 dropped(经 onError 可感知);4xx 语义拒绝(413/422)不重试直接计数。
3. **退避期间页面卸载丢整缓冲**:退避中安排的重试定时器随页面一起死。卸载路径(beacon)
   豁免退避 —— 一次性发射不构成重试风暴,不发就再也没机会。
4. **同 hash 合并保留旧现场**:合并只动 count/时间,breadcrumbs/page/occurred_at 停在窗口内
   第一次发生;云端 last-write-wins 导致展示「崭新 last_seen + 几分钟前的旧轨迹」。
   改为现场字段整体取最新一次发生(count 累加、first_seen 取最早不变)。
5. **HttpError 指纹基数爆炸 + fetch 轨迹刷屏**:URL 去 query/hash 后再进指纹(轮询/搜索/游标
   场景不再每个 query 一个 hash 刷爆配额);连续同一请求的 fetch 轨迹原地折叠成「×N」
   (插入其他轨迹则另起一条),30 格轨迹不再被轮询刷光。
6. **集成层三个 footgun**:SSR 下 provide/$moo 注入被 SSR 判断短路(服务端 inject 得 undefined,
   与 docblock 矛盾)→ 注入提前;`httpErrors.min` 钳到 ≥400(min:0 会把 2xx 也捕成错误);
   `maxBatch` 钳到云端上限 200(超出整批 422 静默拒)。

- 测试 +10(失败回收/卸载豁免/现场保鲜/折叠/钳制/SSR),87 passed。

## 0.3.2

第五轮对抗审查(三视角并行)后的加固:

- **keydown 自噪音**:扩展/测试工具用普通 Event 派发 keydown(无 `.key`)时,
  `ke.key.length` 抛 TypeError → 冒到 window.onerror 被 SDK 自己捕获成「宿主错误」。
  现 key 兜空串,点击/键盘两个轨迹手柄整体 try/catch(出错走 onError,绝不外抛)。
- **大容器点击不再物化整页文本**:元素描述的文本提示改为 BFS 取浅层首段
  (预算 12 节点、跳过 script/style),点击 body 不再把整页 textContent 序列化
  (CPU 尖刺 + 任意页面内容入轨迹)。
- **SVG 资源错误**:`<image>/<use>` 的 href 是 SVGAnimatedString 对象 → 取 baseVal,
  不再产出 "[object SVGAnimatedString]" 垃圾指纹;选择器的 id 同步防 named-getter
  劫持(form 内有 name="id" 的 input 时 form.id 不是字符串)。
- 测试 +2(无 .key 不抛/不自捕获;大容器点击有界提取)。

## 0.3.1

**采集面升级**:操作链路(点击/键盘/路由)、HTTP 错误捕获、会话自动化。

- **操作链路 breadcrumbs**(回应「document 监听点击/键盘、解析操作元素、做出链路」的诉求):
  - 点击:解析**就近交互祖先**(点中 button 里的 span 也归到 button),描述为
    `tag#id.前两类 + aria/可见文本`(如 `button#checkout.btn "去结算"`);
  - 键盘:只记 **Enter/Escape**(提交/取消节点)与「**开始输入** → 目标元素」(同元素连续
    打字聚合一条;ctrl/meta 快捷键忽略)——**绝不记录按键值/输入内容**,输入控件只用
    name/placeholder/type 标识;
  - 路由:包裹 `history.pushState/replaceState` + `popstate`,记 `from → to`
    (哨兵防重复包裹,`close()` 按引用还原)。
- **HTTP 响应错误自动捕获**:经包裹的 fetch,状态码 ≥500(默认;`httpErrors: { min }` 可调,
  `false` 关闭)生成 `HttpError` 记录(合成栈 → 不带 SDK 内部帧;状态码/URL id 随指纹归一聚合);
  自身上报地址豁免(防死循环)。
- **会话自动化**:`autoSession`(默认开)首次取用时生成 24 位 hex 存 sessionStorage
  (标签页生命周期;隐私模式退化为内存级),`setUser({ sessionId })` 优先 ——
  云端「影响用户数/会话数」不再依赖宿主手动注入。
- 测试 +17(元素解析 / 键盘聚合与隐私 / 路由还原 / HTTP 阈值与豁免 / session / beforeSend
  改写与丢弃 —— 后者补上历史缺口);全量 75 passed。

## 0.3.0

**sourcemap 还原(VIP)**:新增 `moo-monitor-vue/vite` 构建插件,与云端还原管线配套。

- **Vite 插件 `mooSourcemapUpload`**:构建结束自动收集产物 `.map` 上传到云端
  `/api/v1/sourcemaps/intake`(multipart,分批 ≤20 文件/请求);选项 `include` /
  `deleteAfterUpload`(上传后删 `.map`,不随站点发布)/ `failOnError`(默认失败只告警、
  不挡构建;403 非 VIP、网络错均放行)/ `silent`。Node 18+ 全局 fetch/FormData,零新依赖。
- **凭证隔离**:上传须用单独签发的「`sourcemaps` 能力」CI token —— 浏览器里的
  `frontend_errors` token 是公开的,云端直接拒绝(无该能力 403)。
- **云端配套**(moo-scaffold-cloud):零依赖流式 Source Map v3 解析(单遍 VLQ,大 map 不爆内存)、
  按 (project, release, 产物名) 覆盖式登记、每项目滚动保留 20 个 release、错误先到 map 后到自动重算;
  还原结果进 详情调用栈 /「复制给 AI 修复」/ 列表出错组件摘要。
- 浏览器 SDK 本体**无行为变化**(`release` 字段早已上报);新 entry 仅构建期使用,不进浏览器包。
- 文档:README「sourcemap 还原(VIP)」+ `docs/sourcemaps.md`(接入清单 / 配额 / 排查表)。
- **出错源码上下文**:云端还原时再从 map 内嵌的 `sourcesContent` 抽出错行 ±3 行源码
  (前 5 个还原帧,逐行截断 + 密钥脱敏后入库)—— 详情抽屉每帧可展开源码、出错行高亮,
  「复制给 AI 修复」markdown 附出错源码块。

## 0.2.4

第四轮审查:**砍掉 carry(跨 flush 去重)** + 集成健壮性。

- **移除跨 flush 去重(carry)**:它自 v0.2.2 引入后反复出 bug(计数搁浅、压制新错误 flush 延迟 ~6×、
  内存无界、与采样交互失真)。改回「单 flush 窗口内按 hash 合并、跨窗口由云端按 (project,hash) 累计」——
  更简单且**不丢计数**,只放弃「持续高频错误少发几个请求」这点边际优化。
- **积压丢弃可感知**:缓冲到 `MAX_BUFFER` 才丢弃,且累计 `dropped` 经 `onError` 回调上抛(不再静默吞错)。
- **Vue Router chunk 失败捕获**:插件新增 `router` 选项,接 `router.onError` 捕获「Loading chunk failed /
  动态 import 失败」(发版后旧 chunk 404 常见,这类不进 errorHandler / window.onerror)。
- **`close()` / 重复 init 不泄漏**:新增 `client.close()`(解绑监听器 + 还原 `fetch` + flush 残余);
  重复 `init()` 自动先关旧实例。微前端 / HMR 友好。
- **SSR 安全**:Vue 插件在无 `window`(服务端)时只 init 命令式 API,不接管 errorHandler / 路由。
- **定时器 `unref`**:Node / SSR 下不拖住进程退出。

## 0.2.3

第三轮审查发现的修复(都源自 v0.2.2 新增的退避 / 跨 flush 去重):

- **退避期不再丢数据**:`flush()` 原先无条件 `splice` buf + 标记 sentAt 再发,退避中 `send` 直接丢 →
  整批永久丢失 + sentAt 污染压制同类。改为退避中**不动 buf/carry/sentAt**,安排退避结束后重试一次;
  并加 `MAX_BUFFER` 上限防长退避期内存无界。
- **carry 计数不再漏发**:同 hash 累积进 carry 后**也 arm 定时器**(原先只有入 buf 才 arm)→ 错误停止 +
  无后续 add 时,carry 累积的计数也能到期被 flush 补发。
- **error.message 出站脱敏**:此前唯独 message 没过 `scrub`(stack/url/frames/breadcrumb 都过了)→
  消息内嵌的 token / 带密钥 URL 会明文上报。现已脱敏(指纹仍用脱敏前文本、仅本地哈希)。

## 0.2.2

对标 Sentry 复盘的 SDK 可靠性升级(Tier 1):

- **429 / Retry-After 退避**:transport 周期发送改用可读的 fetch,命中云端限流(429)时读 `Retry-After`
  进入退避期,期间直接丢弃不再打云端(保护入口,优于盲目重试);页面卸载仍用 `sendBeacon`。
- **flush 不再假成功**:`flush(useBeacon)` 据派发结果返回(退避中/无通道 → false),不再恒 true。
- **跨 flush 去重**:近期(30s TTL)已发过的同 hash 不立即重发,累积到 carry、到期补发一次,
  削减高频错误的请求量(与单批内合并 + 云端按 hash 累计协同)。

## 0.2.1

第二轮审查发现的修复:

- **SDK 帧过滤改为与打包无关**:上一版靠文件名 `moo-monitor-vue` 匹配剔除 SDK 帧,生产打包后路径不含包名 → 形同虚设。改为按 `input instanceof Error` 判定:真·Error 保留业务栈;SDK 合成的 Error(字符串 / onerror 仅 message)丢弃内部栈、用 `onerror` 位置补帧。
- **出站脱敏(默认安全)**:新增 `scrub`(与云端 SecretRedactor 同规则),离开浏览器前对 page url / referrer、堆栈帧 file、原始 stack、breadcrumb message 里的 `token=…` / JWT / Bearer 打码 —— 不再仅靠 opt-in `beforeSend`。
- **批体积按真实 UTF-8 字节**:`queue` 改用 `TextEncoder` 计字节(原 `.length` 是 UTF-16 码元数,中文每字低估 3×,会绕过分批阈值导致 sendBeacon 静默丢);`truncateRecord` 二轮也丢 `frames`。
- 合并时 `last_seen` 取最新、`first_seen` 取最早(防乱序回退)。补测:scrub、CJK 字节分批、合成栈丢弃 + 脱敏。

## 0.2.0

审查团队对抗式复核后的修复与硬化(数据保真 / 健壮性 / 工程化):

### 修复
- **count 不再恒为 1**:队列按 hash 合并并累加 `count`(SDK 成为真正的聚合源),配合云端累加语义
  —— 修复趋势火花线、复发(RECUR)告警此前对前端错误失效的问题。**需 cloud 端配套**(已发布)。
- **first_seen**:SDK 上报首见时刻;云端仅在新建记录时采用,已存在记录不再被覆盖成 now()。
- **循环引用 / 不可序列化抛值**:安全序列化(标 `[Circular]`),不再全部塌缩成 'Unknown error'。
- **指纹分组**:只抹平易变的数字 / 十六进制 / 长 id,保留引号内属性名 —— 不同错误不再被误聚成一类。
- **fetch 重复包裹**:重复 `init()` 不再叠加包裹 `window.fetch`(哨兵 `__mooPatched`)。
- **Vue 组件名**:`<script setup>` SFC 改用编译注入的 `type.__name`(回退 `type.name` / `$options.name`)。
- **UA 解析**:修 iOS 被误判成 macOS(iOS UA 含「like Mac OS X」);新增设备类型(Mobile/Tablet/Desktop)。
- **堆栈解析**:eval 帧不再泄露内部位置(标 `file=eval`),native 帧保留函数名不再丢帧。

### 可靠性
- **64KB 上限**:flush 按字节分批(单批 ≤ 56KB),单条超限自动截断 stack/breadcrumbs/message
  —— 避开 sendBeacon / fetch keepalive 的静默丢弃。

### 工程化
- 开启 `noUnusedLocals` / `noUnusedParameters`;新增 ESLint(flat config)+ `lint` 脚本。
- `prepublishOnly`:发布前自动 typecheck + lint + test + build,杜绝发出陈旧产物。
- 新增 CI(GitHub Actions)。补齐 core 单测(queue / stacktrace / uaParse / client / 循环引用)。

## 0.1.0

首个版本:framework-agnostic core + Vue 适配层;四大捕获通道(onerror / unhandledrejection /
Vue errorHandler / 资源错误)+ breadcrumbs + 上下文 + 可靠上报(sendBeacon)。
