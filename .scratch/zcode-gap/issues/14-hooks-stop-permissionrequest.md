# 14: Hooks 扩展②：Stop block 续跑 + PermissionRequest 自动决策

**What to build:** 在工单 13 的协议基础上补齐另外两个高价值事件。(1) Stop：主模型准备结束回合时触发，hook 返回 block + 理由则当前模型循环继续（例如"还没给出测试命令和结果，补齐再结束"），连续 block 达上限（3 次）后强制结束防死循环。(2) PermissionRequest：仅在权限结果需要询问用户时触发，hook 可自动 allow 或 deny 并附理由——deny 优先于 ask、ask 优先于 allow 聚合；硬拒绝（HARD_DENY）与凭据路径边界不可被 hook 的 allow 绕过。两者都进权限链的既有回归套件。

**Blocked by:** 13 (Hooks 扩展①：PreToolUse veto + UserPromptSubmit)

**Status:** done（`91a14a8`；2026-09-27 逐项复核 + 补上示例验证脚本）

## 收口（2026-09-27）

- [x] Stop hook 返回 block → 模型继续一轮，理由模型可见；连续 3 次后强制结束并记录 — `hookDecisions.nextStopBlocks` + `MAX_STOP_BLOCKS = 3`（连续计数：未被 block 的 settle 归零、新的人类 prompt 归零）；上限后不再 prompt 但必留痕（审计 `kind:'hook'` + `observeEvent`）；单测 `tests/hookChecks.test.ts:296`「blocks with the reason when the hook says not yet」、`:308`「passes the last assistant message so a hook can judge the turn」
- [x] PermissionRequest hook 触发时机正确：仅在需要询问用户时 — worker `beforeToolCall` 的权限 ask 分支（会问人类的那一支）；单测 `:330`「does not run at all when nothing is registered」
- [x] hook allow/deny 生效，聚合顺序 deny > ask > allow — `aggregatePermissionDecisions`；单测 `:357`「a denial from the second hook outranks an allowance from the first」、`:380`「ask outranks allow」
- [x] HARD_DENY 与凭据路径边界不可被 hook allow 绕过（有反向测试用例） — `hookAllowIsOverridable`（`hookDecisions.ts`）；反向用例在**两处**：单测 `:414`「a hook that blocks outright without JSON meant to refuse」+ `scripts/perm-regress.mjs:130`「hook allow cannot lift a hard deny」
- [x] 权限链回归套件全绿（perm-regress 扩展新用例） — 本日实跑 `node scripts/perm-regress.mjs` → **52/52 PASS**（已有 14 的 hook 用例在内）
- [x] 示例 hook + 验证脚本入库 — `examples/hooks/hooks.json` 有 Stop/PermissionRequest 段、`examples/hooks/veto-demo.mjs` 有对应分支；**本日补上驱动它们的验证脚本**：`scripts/demo-hooks.mjs` 原本只跑 13 的两个事件，现扩到 10 项覆盖四个事件（Stop 续跑 / Stop 放行 / PermissionRequest deny / allow / 弃权），实跑 10/10
- [x] 插件/hook 文档补全这两个事件的契约 — `docs/plugin-backend.md` §8：事件表（触发点 + 语义）、Stop 续跑上限与归零规则、PermissionRequest 的"可收紧不可放宽"不对称、stdin 载荷（`stop_hook_active`/`last_assistant_message`）、stdout 决策形状（`hookSpecificOutput.permissionDecision`，扁平写法与 `block`→deny 的兼容，看不懂 = 弃权）

**未闭环**：Stop 的 3 次上限与"强制结束后"的界面表现没有真机走查（需要真模型连续被 block 三轮）。
