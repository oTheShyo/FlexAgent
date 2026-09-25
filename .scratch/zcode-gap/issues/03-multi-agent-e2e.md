# 03: 多智能体端到端验证

**What to build:** 用真实模型把 `task` 子智能体工具跑通并留下证据，消除 docs/multi-agent.md 中"未端到端验证"的声明。覆盖三种派发形态：单发（single）、并行（parallel）、链式（chain/引用前序结果）。验证子智能体的上下文隔离（子代理看不到主对话内部）、工具白名单真实生效、深度上限为 1（子代理不能再派子代理）、权限决策继承主会话。验证过程中暴露的 bug 一并修复。

**Blocked by:** 01 (落库未提交子系统)

**Status:** done (committed 21fc0ed + 777b3f5; evidence: reports/03-multie2e-evidence.json, 46/46 checks)

- [x] 真实模型下 single/parallel/chain 各至少一个成功用例，结果与证据（验收脚本输出或文档记录）入库 — `node scripts/diag-multie2e.mjs` 7 阶段 46/46；证据 `.scratch/zcode-gap/reports/03-multie2e-evidence.json`
- [x] 工具白名单实测：子智能体拿不到清单外工具 — whitelist 阶段：researcher 实测工具集 `read,grep,find,ls`
- [x] 深度上限实测：子智能体内的再派发被拒绝 — 子代理调用 `task` 返回 `TOOL_NOT_AVAILABLE`
- [x] 权限继承实测：子智能体触发的高危操作按主会话权限模式处理 — perm-default：`subagent-*` 转发 → deny → 探针未生成 + `child-permission` 审计；perm-bypass：无弹窗直接执行
- [x] 发现的 bug 已修复并有回归覆盖（优先写进工单 02 的单测，或验收脚本）— 修复双 id 空间寻址 bug（`parentLookup.ts` + `worker.ts` 两处接入）；回归 `tests/multiAgentParentLookup.test.ts`（5 例）+ 验收脚本 `single`/`perm-default`
- [x] docs/multi-agent.md 更新：移除"未验证"声明，写明验证方式与日期 — 已改为 2026-09-26 端到端实测记录
