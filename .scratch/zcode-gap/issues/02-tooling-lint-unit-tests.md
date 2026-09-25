# 02: 工程工具链（lint + 单测 runner）

**What to build:** 在 typecheck 之外建立两道质量门禁：一个 lint/format 工具链（推荐 oxlint 或 eslint+prettier，与仓库 TS 7 / React 19 栈匹配），和一个可运行的单测 runner（vitest）。首批单测覆盖三块高风险纯逻辑：权限链的五层决策顺序与 HARD_DENY、技能写入管线的审批/回滚（staged → approve → revert）、hook 协议的 stdin/stdout 解析与超时/输出上限。提供一条命令跑全部门禁，供后续所有工单做回归。

**Blocked by:** 01 (落库未提交子系统)

**Status:** done (committed 766e3b1; report: reports/02-tooling-lint-unit-tests.md)

- [x] `npm run lint` 可用且通过（存量违规要么修复、要么进有注释的显式豁免清单，不允许静默忽略）
- [x] `npm run test`（vitest）可运行，不依赖 Electron 窗口（纯逻辑层测试）
- [x] 权限链决策顺序 + HARD_DENY 不可绕过：有单测
- [x] 技能审批（approve/reject/revert）路径：有单测
- [x] hook 协议解析（合法 JSON / 非 JSON 诊断 / 退出码语义 / 超时）：有单测
- [x] 门禁脚本串联：lint + typecheck + test 一条命令全跑
- [x] 工单 03/05/11/13 的验收标准允许引用该单测框架写回归用例
