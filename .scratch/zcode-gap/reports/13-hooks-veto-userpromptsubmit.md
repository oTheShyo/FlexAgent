# Ticket 13-hooks-veto-userpromptsubmit — Final Report

Commits: (orchestrator commits this lane).
Attempts: agent session 1 (timeout, zero output), agent session 2 (timeout, zero output), agent session 3 (wrote `src/main/hooks/hookRunner.ts` + worker wiring, then timed out), orchestrator completed the enforcement points, example, tests, docs, report.

## 交付物

- `src/main/hooks/hookRunner.ts`（agent 会话 3 产出，orchestrator 补一处修复）：`runHook` — spawn（command shell / process 直启）、stdin JSON 载荷、60s 默认超时 + taskkill 树杀、32KB 输出上限、spawn_error/timeout/killed/failed 状态、stdout JSON 校验（decision/reason/stopReason/additionalContext）、env overlay（CLAUDE/ZCODE/FLEX 三前缀）、**exit-2 veto reason 解析修复**（原实现 blockReason 用原始 stdout，现优先解析 JSON 的 reason/stopReason）。
- `src/main/pluginBridge.ts`：`RegisteredHookCheck` 类型 + `PluginHookDeps` 增 `preToolUseChecks`/`promptSubmitChecks` 注册表；`registerPluginHooks` 把 PreToolUse/UserPromptSubmit 注册为**强制检查**（其余事件仍 `pi.on` 透传）；`runHookChecks`（matcher 过滤 → 插值 → runHook → block 判定/additionalContext 收集，first-block-wins）+ 导出 `runPreToolUseHooks`/`runPromptSubmitHooks`；`buildHookStdin` 增 `prompt` 字段（原实现丢弃 UserPromptSubmit 的 prompt）；block-ignored 诊断消息更新（仅无强制点的事件）。
- `src/main/worker.ts`：`beforeToolCall` — 权限门放行后运行 PreToolUse checks，veto → `denials.set`（reason 经 denials 通道进 transcript 达模型，与权限拒绝同通道）+ `hook_veto` 事件 + `{block:true, reason}`；prompt handler — `started` 路径运行 UserPromptSubmit checks，阻断 → `hook_block` 事件 + `INVALID_INPUT`（主模型不调用、run_state 不变），`additionalContext` append-only 拼进发出的 prompt（用户原文不改写）+ `hook_context` 事件。
- `examples/hooks/hooks.json` + `examples/hooks/veto-demo.mjs`：可运行示例（两类事件、matcher 过滤、DO-NOT-WRITE veto、BLOCK-DEMO 阻断）。
- `scripts/demo-hooks.mjs`：一键演示（真实协议：spawn + stdin 载荷 + 决策解析）。
- `tests/hookChecks.test.ts`（18 项新）+ `tests/hookProtocol.test.ts`（4 项按新契约改写：PreToolUse 从 kernel 事件注册改为 checks 注册，block 从 ignored 改为 enforced veto）。
- `docs/plugin-backend.md` §8：事件分治表、stdin/输出契约、matcher 语义、强制点与可观测、示例。

## 逐项验收

| # | 项 | 状态 | 证据 |
| - | -- | -- | -- |
| 1 | PreToolUse veto → 工具不执行、reason 进模型上下文、事件日志可查 | ✅ | worker beforeToolCall veto 路径（denials 通道与权限拒绝同构——该通道"reason 进 transcript 达模型"已由权限链 e2e 验证）；`hook_veto` observeEvent；hookProtocol 真子进程测试 exit-2 → blocked+reason |
| 2 | matcher 按工具名过滤 | ✅ | `matchesHookMatcher`（`a|b` 精确/正则/`*`）+ 测试：Bash 被 `Write|Edit` 跳过（demo 第 3 项 + 单测） |
| 3 | UserPromptSubmit additionalContext 注入（模型首轮可见） | ✅ | prompt handler started 路径 + append-only 拼接；单测收集/join；demo 第 4 项 |
| 4 | UserPromptSubmit 阻断：用户看到原因、主模型不被调用 | ✅ | `hook_block` 事件 + `INVALID_INPUT` 抛出（先于 `host.session.prompt`，run_state 不变）；单测 blocked+reason；demo 第 5 项 |
| 5 | 超时/非 JSON/异常退出按现有诊断语义 | ✅ | runHook：60s 默认超时+taskkill、32KB 上限、非 JSON 忽略、spawn_error 不崩 session；单测 4 项覆盖 |
| 6 | 示例 hook + 验证脚本入库（一键演示两事件） | ✅ | `examples/hooks/` + `node scripts/demo-hooks.mjs` → **5/5 PASS EXIT=0** |
| 7 | 协议解析与 veto 决策 vitest 单测 | ✅ | hookChecks 18 项 + hookProtocol 16 项（4 项改写） |
| 8 | 插件/hook 文档更新 | ✅ | docs/plugin-backend.md §8（事件表/stdin/输出/matcher/强制点/可观测/示例） |

## 门禁

- `npm run test`：**93/93 PASS**（75 基线 + 18 新，hookProtocol 4 项改写后仍 16/16）
- `npx tsc --noEmit -p tsconfig.test.json`：0；`-p tsconfig.node.json`：0
- `npx oxlint`（5 个车道文件）：0
- 全库 lint/typecheck 仍各 1 处已知外来失败（pluginMcpOverrides.ts:16、useChat.ts:46）——非本车道

## 诚实缺口

- veto 的端到端（真实 app 内发消息被 hook 拦）未跑：veto 与权限拒绝共用同一条 denials→transcript 通道（该通道已被权限链 e2e 验证），加上 bridge 层真子进程测试与 demo 脚本，证据链完整；但"app 内一键演示"需 dev server + 窗口（与 diag-multie2e 同样的取舍）。
- `SessionStart`/`PostToolUse` 等 block 仍仅观测（有强制点的事件只有 PreToolUse/UserPromptSubmit，符合工单范围）。
- UserPromptSubmit 仅 `started` 路径触发（steering/queued 是已运行回合的一部分，契约即"模型请求发起前"）——已在 docs §8 注明。
