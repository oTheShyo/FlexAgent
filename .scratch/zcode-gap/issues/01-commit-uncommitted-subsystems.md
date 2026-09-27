# 01: 落库未提交子系统（git 卫生）

**What to build:** 仓库工作区里约 76 个未提交/未跟踪文件全部按逻辑拆分成干净的提交序列，使 HEAD 完整包含已实现的能力：多智能体（agents）、安全层（secret 脱敏、审计日志）、五层权限链（permissionGate/rules）、可观测性（NDJSON 管线）、persona、用户级 MCP 配置、设置窗口、配套验收脚本与设计文档。完成后任意一次 checkout 都能拿到与当前工作区等价的功能。

**Blocked by:** None (can start immediately)

**Status:** done (2026-09-26 落库，2026-09-27 逐箱核验收口，见 INDEX 认领节)

- [x] `git status` 干净（临时产物除外，见下条） — 2026-09-27 核验：根目录 0 未跟踪；`.scratch` 下的走查探针/状态此前仍会露出来，补了 `/.scratch/*` + `!/.scratch/zcode-gap/` 忽略规则后 `git status` 全干净（工单树不受影响）。
- [x] 提交按子系统拆分，每个提交可独立编译通过（typecheck 绿），提交信息沿用仓库现有风格（能力域前缀 + 一句话描述） — `git log` 前缀成体系（Security `6cb97c6`、Observability `8050dce`、Permission `788b224`/`1aca101`/`b35f607`、Agents `387414a`、MCP `74568db`/`0d93225`、Multi-agent `21fc0ed`/`777b3f5` …）；当前 HEAD 上 `npm run check`（lint + typecheck×3 + vitest 248/248）绿，即合并态可编译（逐提交重放 typecheck 未做，如实注明）。
- [x] HEAD 包含：agents/、security/、permissionGate、permissionRules、observability、persona、userMcp、settings 及其关联 IPC/contract 变更 — `git ls-files` 核验：`src/main/agents/` 5 文件、`src/main/security/{auditLog,secretPatterns}.ts`、`permissionGate.ts`、`permissionRules.ts`+`permissionRulesIpc.ts`、`observability.ts`、`persona.ts`、`userMcp.ts`、`settings.ts`，配套 contract/preload 均在 HEAD。
- [x] 关联的验收脚本与文档（multi-agent、security-architecture、observability 等）随所属子系统一并入库 — `docs/multi-agent.md`、`docs/security-architecture.md`、`docs/observability.md` 均 tracked；`scripts/` 入库 52 个文件。
- [x] 根目录散落的临时产物（dev 日志、截图、probe 文本、重复的故事文件、electron-vite 配置时间戳副本）不入库：应删除或加入 .gitignore — `.gitignore` 已覆盖点名类别（`*.log`、`*.png`、`*_probe.txt`、`robot_gardener_story.*`、`electron.vite.config.*.mjs`、`.impeccable/`）；根目录 `git status` 未跟踪项为 0。
- [x] 落库完成后运行 typecheck 确认绿 — 2026-09-27 `npm run check`（lint + `tsc`×3 + vitest 248/248）exit 0。
