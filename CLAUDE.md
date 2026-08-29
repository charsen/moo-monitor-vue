# CLAUDE.md

本仓库的完整协作、浏览器采集、隐私、投递、sourcemap 和发布规则统一维护在 [`AGENTS.md`](./AGENTS.md)。开始任务前必须完整阅读并遵守它，本文件不维护第二份重复规则。

特别提醒：

- 开工先读 `NOTES.md`，再按任务读 `docs/overview.md` 与 sourcemap/调优文档。
- core、Vue 适配和 Vite 插件是三个运行时边界，公共导出与 package `exports` 必须同步。
- 所有敏感信息必须在截断前脱敏；SDK 自身错误绝不能抛回宿主。
- `autoBreadcrumbs`、`httpErrors`、队列回收和 Debug ID/SRI 互斥是现有契约，不得静默改变。
