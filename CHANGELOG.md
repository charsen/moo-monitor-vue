# Changelog

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
