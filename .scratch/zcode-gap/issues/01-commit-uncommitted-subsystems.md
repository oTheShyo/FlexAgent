# 01: 落库未提交子系统（git 卫生）

**What to build:** 仓库工作区里约 76 个未提交/未跟踪文件全部按逻辑拆分成干净的提交序列，使 HEAD 完整包含已实现的能力：多智能体（agents）、安全层（secret 脱敏、审计日志）、五层权限链（permissionGate/rules）、可观测性（NDJSON 管线）、persona、用户级 MCP 配置、设置窗口、配套验收脚本与设计文档。完成后任意一次 checkout 都能拿到与当前工作区等价的功能。

**Blocked by:** None (can start immediately)

**Status:** done (2026-09-26, 见 INDEX 认领节)

- [ ] `git status` 干净（临时产物除外，见下条）
- [ ] 提交按子系统拆分，每个提交可独立编译通过（typecheck 绿），提交信息沿用仓库现有风格（能力域前缀 + 一句话描述）
- [ ] HEAD 包含：agents/、security/、permissionGate、permissionRules、observability、persona、userMcp、settings 及其关联 IPC/contract 变更
- [ ] 关联的验收脚本与文档（multi-agent、security-architecture、observability 等）随所属子系统一并入库
- [ ] 根目录散落的临时产物（dev 日志、截图、probe 文本、重复的故事文件、electron-vite 配置时间戳副本）不入库：应删除或加入 .gitignore
- [ ] 落库完成后运行 typecheck 确认绿
