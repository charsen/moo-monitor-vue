# Changelog

## 0.3.13

sourcemap 管线五项闭环 —— 上传即验证、发布可观测(云端配套:intake 响应 health 块 /
`/sourcemaps/check` / `source_mode` / 可还原率列,migration `2026_07_02_000001`):

1. **CI strict 强约束**:插件新增 `strict: true | { requireAllFiles, requireDebugIds,
   allowDuplicateDebugIds }` —— 上传后按云端回执 health 校验文件数齐全 / Debug ID
   100% 覆盖 / 无重复 Debug ID / 回执数量一致,不达标抛错挡构建;上传中断、配置缺失、
   云端未返回 health(版本过旧)同样硬失败 —— strict 的语义是「构建通过 = map 一定
   可用」,任何静默放行都是假保证。**需先升级云端再开 strict**。
2. **SDK 运行时 release 自检**:`releaseCheck: true | { sampleRate, app }` ——
   初始化后抽样调云端 `/sourcemaps/check`(复用浏览器上报 token,聚合只读),
   提前发现「代码已发、map 没传/传错」,仅 console.warn 提示不打扰用户。
3. **源码安全分级**:插件 `sourceMode: 'context' | 'position'` —— position 档上传前
   本地剥离 sourcesContent(云端存储侧同样兜底剥离),仅还原错误位置、不含源码上下文,
   适合源码敏感项目;默认 context 不变。
4. **本地归档**:`archiveDir` —— 上传前把 map 归档到 `archiveDir/release/app/`
   (含 manifest.json 清单),自留底、不依赖云端保留策略(云端默认 15 天 / 5 个 release)。
5. **release 解析器**:导出 `resolveMooRelease()`(git describe → 最新 tag → fallback)
   + `moo-monitor-release` CLI(bin),vite.config 与 CI 两侧共用同一 release 口径。

- 测试 +10(strict 达标/不达标/无 health 不静默放行/上传中断 · releaseCheck 采样与
  关闭 · sourceMode 剥离 · archiveDir 归档 · release 解析),129 passed。

## 0.3.12

sourcemap × 行为轨迹 对抗自审 —— 修复 3 个问题:

1. **XHR 未插桩(大洞)**:axios 在浏览器默认走 XMLHttpRequest —— 此前 axios 应用
   (国内 Vue 项目主流)的 API 请求完全不进轨迹、HTTP ≥500 不捕获、发起帧缺失,
   轨迹里只剩第三方统计的 fetch。补 XHR 插桩(open 记 method/url、send 同步留存
   调用栈、loadend 统一落格;status 0 = 网络失败只记轨迹),与 fetch 共用
   落格/捕获/采帧/折叠逻辑;哨兵防叠包,close() 还原原型。
2. **发起帧永远指向请求封装层**:几乎所有项目都有 request() 封装,单帧候选常年
   命中封装文件同一行。改为携带前 3 个候选帧(data.frames,兼容旧 data.frame),
   云端按序还原、取第一个源路径不含 node_modules/ 的业务帧。
3. **第三方统计请求刷屏轨迹**:GA/GTM 每次 URL 都不同,折叠救不了,30 格轨迹被
   刷满、用户操作被淹没。新增 ignoreFetchUrls 选项,默认内置常见统计域名
   (GA/GTM/doubleclick/clarity/百度统计/CNZZ/友盟/神策/GrowingIO),
   不进轨迹也不触发 HttpError;传 [] 全保留。

- 测试 +3(XHR 全链路与还原原型 / 忽略名单与关闭 / 多候选帧),119 passed;
  云端配套(候选帧择优,无迁移)。

## 0.3.11

轨迹源码化(0.3.10)对抗自审 —— 修复 3 个问题:

1. **「发起于」指向 SDK 自己(致命)**:调用帧在响应回调里采,微任务栈上业务调用方
   早已不在,兜底取到的栈底帧就是 SDK 补丁代码。改为 patched fetch 调用时【同步】
   留存栈字符串(仅一行,微秒级),失败时才解析,取跳过补丁自身的第 2 帧。
2. **组件名永远是库组件**:ant-design 等场景从 input 反查,实例链首个有名字的是
   AInput/ElButton —— 每条轨迹标 `· AInput` 毫无信息量。沿链跳过常见 UI 库前缀
   (A/El/Van/N/Q/T/Lay/Prime/Ion/Arco + 大写),取业务组件;全是库组件时回退首个;
   DOM 爬升 8→24 层、实例链 12→20 层(antd 包装层级深)。
3. **复发后「发起于」永久消失**(云端配套):复发时 upsert 覆盖 breadcrumbs
   (新 data.frame、无 data.src)而 src_resolved_at 已盖戳 → 新轨迹帧永不还原。
   needsResolution 增加轨迹帧待还原分支,按距上次解析 ≥10 分钟节流
   (热错误每分钟复发上百次,不能每次重解析大 map)。

- 测试更新 +1(真栈时机断言 / 库组件跳过与回退 / 复发节流重做),116 passed。

## 0.3.10

**行为轨迹「源码化」**(同事提议):轨迹不再只是 DOM 选择器和 URL,两层增强 ——

1. **点击/输入/按键轨迹带所属 Vue 组件名**:从 DOM 元素经 __vueParentComponent 反查
   实例链上第一个有名字的组件(编译期注入的字面量,生产压缩保留)——
   `button.ant-btn "登录" · LoginForm`。非 Vue 区域自动省略,反查失败不影响轨迹本体。
2. **失败 fetch 轨迹带发起方调用帧**:level=error 的请求采一帧调用位置
   (best-effort,含 debug_id;成功请求零成本不采)放 crumb.data.frame;
   云端在还原栈帧的同一遍 sourcemap 解析里顺手还原,时间线显示
   「↳ 发起于 src/api/login.ts:42」(原压缩帧保留在 data.frame 可追溯)。
   需云端配套部署(无迁移)。

- 测试 +2(组件名反查 / 失败采帧·成功不采),116 passed。

## 0.3.9

按同事真实测试环境(monorepo 多应用、大 map、本地打包)推演的三修:

1. **monorepo 多应用互相清集**:admin/website 等多个 Vite 应用共用同一 release/token
   上传时,构建集替换会把彼此的当前集清掉(两应用恰好挤满「保留两集」名额,第三次
   交错上传必坏)。插件新增 `app` 选项,云端构建集替换与配额按 (release, app) 分桶;
   单应用项目不填无感。**monorepo 各应用务必配置不同 app**。需云端配套(migrate)。
2. **大 map 撞 post_max_size 报误导性 401**:分块只按条数(20 个),大 map 项目单请求
   可达数十 MB,超过服务器 post_max_size(常见默认 8M)时整个 POST 被 PHP 丢弃,
   Laravel 连 token 都读不到 → 401。分块加「累计 ≤6MB」约束;413 时给出
   「调 post_max_size / upload_max_filesize ≥20M」的明话。
3. **上传后约 2 分钟才生效、无预期提示**:防抖收尾(~95s)+ 队列消费,传完立刻看
   错误会以为没生效。云端响应带 finalize_eta_seconds,插件成功日志注明
   「约 2 分钟后生效」。

- 测试 +3(字节分块 / app 表单与 413 明话 / 生效预期日志),114 passed。

## 0.3.8

**构建集替换** —— 修复同 release 重复构建导致的 sourcemap 无限堆积。

- 问题:Vite 产物文件名带内容 hash,每次构建全部改名 → 同 release 重复构建时
  旧工件按 (release, 文件名) 永远匹配不上、也不被跨 release 滚动清理覆盖,
  实测一个 release 堆了 1872 个文件(39.6MB),逼近 50MB 配额后开始误拒新文件。
- 修复:插件按「全部 map 文件名排序哈希」生成**确定性 build_id** 随每个分块上传;
  云端收到带 build_id 的请求先清掉同 release 下不属于本构建的旧工件
  (含修复上线前的历史遗留行)。同一构建的分块/断点补传/CI 重跑同内容互不影响;
  curl 不带 build_id 保持旧语义。需云端配套(migrate)。

## 0.3.7

**Debug ID 全链路(对标 Sentry)+ 文件名唯一回退** —— sourcemap 匹配不再依赖「release 三处一致」。

- **Vite 插件注入(默认开,`injectDebugIds: false` 可关)**:上传前给每个 bundle 注入
  确定性 Debug ID(js 内容 sha256 派生,watch 重跑不漂移)——
  js 头部一行注册 snippet(以 `new Error().stack` 为键存 ID,栈里带着 chunk 被浏览器
  实际加载的 URL)+ `//# debugId=` 注释(置于 sourceMappingURL 前);
  map 写 `debug_id` 字段,`mappings` 前补 `;` 补偿行偏移。幂等(watch 增量跳过)。
- **SDK 运行时**:懒解析 `window._mooDebugIds` 注册表(键数变化时重建,兼容懒加载 chunk),
  栈帧携带 `debug_id` 上报(用脱敏前的原始 URL 匹配)。
- **云端配套(需同步部署)**:`release_artifacts.debug_id` 列;三级匹配链
  `debug_id → (release, basename) → basename 项目内唯一回退`(同名不同内容绝不瞎猜);
  还原不再硬依赖 release;派发条件改「项目有任何工件」。
- 效果:**release 三处一致从硬约束降级为建议**;传错构建批次显式匹配失败而非错位还原;
  同名 chunk / CDN 改路径 / 灰度多版本混跑全部免疫。老 SDK / curl 上传完全兼容(走 ②③)。
- 测试:SDK +2(注入幂等确定性 / 注册表→帧),111 passed;云端 +4(三级链各路径),303 passed。

## 0.3.6

第九轮对抗审查 —— 修复 6 个问题:

1. **setExtra 无界且超限连坐**:一个大 extra(如整棵 store 快照)让每条记录超限,
   截断二轮会把 frames/breadcrumbs 一起炸掉。setExtra 序列化超 8KB 占位替换
   (循环引用/BigInt 同);截断改分级:先只丢 payload,够了就保住栈和轨迹。
2. **Vite 插件 deleteAfterUpload × sourcemap:true 留悬空注释**:map 删了、JS 尾部
   sourceMappingURL 注释还在 → 全量访客 devtools 每 chunk 一个 404。configResolved
   读最终配置,该组合下删 map 同时剥掉注释(等效 'hidden');文件被云端拒而跳过删除时
   明示「产物目录仍有源码」。
3. **__mooSeen 防双计标记泄漏**:对 throw {code:403} 这类非 Error 抛掷物,可枚举属性
   会被序列化进上报消息与两端指纹。改 Object.defineProperty 不可枚举。
4. **stableFile 误伤与漏配**:user-settings.js(人工命名)被当 hash 剥掉、与真 user.js
   误归并;app-Df3kZ2Lz.min.js 又漏配。约束改为「段须含数字 + 兼容 .min.js」
   (云端 serverHash 同步,需配套部署)。
5. **queue 两处滞留不 arm**:同步派发失败回收后、语义拒绝(413/422)计数后都不安排
   下一次 flush —— 安静页面上记录滞留、onDrop 回执要等下个错误才响。补 arm。
6. **国产内嵌浏览器识别**:微信(MicroMessenger)/ 钉钉 / QQ / UC 的 UA 都带 Chrome/,
   全被识别成 Chrome —— 国内产品错误大户恰是微信内嵌页,浏览器分布完全失真。
   新增四家识别,置于 Chrome 判定之前。

- README 修订:脱敏措辞(SDK 出站打码,云端双兜底)、选项表补 onError
  (0.3.3 的替换静默失败,本次已验证)、hash 字段注明「仅客户端合并用,云端重算」。
- 测试 +7,109 passed。

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
