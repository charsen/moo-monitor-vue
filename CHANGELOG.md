# Changelog

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
