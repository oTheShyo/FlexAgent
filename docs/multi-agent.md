# 多 Agent 协作（v2.1）

依据《Alice 工程方法论 · 第六章：多 Agent 协作》的三模式设计实现。内核 PI 无内置 subagent API，实现走 `createAgentSession` 同 worker 并发多 session 路线（参考 PI 官方 subagent 示例的参数约束）。

## 机制对照

| 文章机制 | 实现 | 位置 |
|---|---|---|
| 父子 Subagent | `task` 工具 single 模式 | `src/main/agents/multiAgent.ts` |
| 只读并行 / 写串行 | parallel 模式 + `canRunInParallel` 对称校验，不兼容即拒绝 | `multiAgent.ts` / `roles.ts` |
| Coordinator 原则（研究先行 / 读写分离 / 验证用新 Worker / 不委托理解） | `task` 工具 `promptGuidelines` 注入 | `multiAgent.ts` |
| Swarm 持久化任务队列 + 原子领取 + 依赖 DAG | `swarm` 工具 + `SwarmTaskQueue` | `src/main/agents/swarmQueue.ts` |
| `{previous}` 链式传递 | `task` chain 模式 | `multiAgent.ts` |
| 角色系统（独立人设 / 工具集 / 并发声明） | 6 角色：researcher / translator / writer / developer / analyst / designer / peer | `src/main/agents/roles.ts` |
| 对称并行兼容声明 | `auditSymmetry()` 启动即拒；不对称对取保守串行 | `roles.ts` |
| 上下文隔离 | 子 session 用 `SessionManager.inMemory()`，无盘、不共享上下文，只回收最终消息 | `multiAgent.ts` |
| 工具隔离 | 子 agent 工具 = 内置工具白名单；resource loader 以 `noExtensions/noSkills` 构建 → `task`/`skill_manage`/`memory_manage`/MCP 对子 agent 不存在，**嵌套深度硬顶 1 层** | `multiAgent.ts` |
| 记忆隔离 | 子 agent 落盘为零 + 无记忆工具 → 输出不可能进入记忆提炼管道 | 同上 |
| 权限向下传递 | 子 agent 工具调用按**父会话当前 mode** 评估；ask 经父会话 UI 通道（合成 toolCallId `subagent-*`），用户裁决后放行 | `worker.ts` `forwardChildPermission` |
| 降级机制 | 不适用（子 agent 本就在 worker 线程内，共享 ModelRuntime） | — |

## 模式选择逻辑（注入给模型）

- 边界清晰、子任务数可知 → `task` single / parallel
- 分解本身需要推理、子任务有顺序 → `task` chain + 自己综合
- 任务动态产生、需跨会话 → `swarm` submit + 多个 peer worker 并行领取

## Swarm 队列

- 文件：`~/.flexagent/swarm/tasks.json`（`FLEXAGENT_SWARM_HOME` 可覆盖诊断路径）；同卷 tmp + `renameSync` 原子替换。
- 领取原子性：worker 单线程 + 同步变更，check-then-mark 不可分割；文件是持久性副本而非协调点。
- 崩溃恢复：加载时 `claimed → pending`（worker 重启 = peer 全灭）；`done` 与 result 持久保留，已完成工作不重跑。
- 依赖校验：未知 dep / 自依赖 / 已 failed 的 dep 一律拒绝提交；`fail` 是终态（防止坏任务无限循环），由 coordinator 清理下游。

## 并发参数

与 PI 官方 subagent 示例一致：`MAX_PARALLEL_TASKS = 8`，`MAX_CONCURRENCY = 4`，单任务输出截断 32KB。子 agent 共享 worker 全局 `ModelRuntime`；子 loader 按 cwd 缓存（无扩展、~1s 建一次后摊销）。

## 已验证 / 未验证

- ✅ `npm run build` 绿；本轨文件 tsc 干净（工作区其余 tsc 报错来自另一条轨道的在制品）。
- ✅ 队列 + 角色并发表逻辑 19/19：`node --experimental-strip-types scripts/diag-swarm-queue.mjs`（临时目录，不碰真实队列）。
- ✅ **端到端实测（真实模型，2026-09-26）**：`node scripts/diag-multie2e.mjs`（直驱 `out/main/worker.js`，与应用同一条 worker 派发链路），7 阶段 46/46 检查全过，证据落盘 `.scratch/zcode-gap/reports/03-multie2e-evidence.json`，交叉证据为 `~/.flexagent/observability/llm-calls.jsonl` 的 `role_task` 行、`~/.flexagent/audit/*.jsonl` 的 `child-permission` 行、PI transcript 中的 `task` 工具结果：
  - **single / parallel / chain 各一成功用例**：single 子报告经 `task` 工具结果回传；parallel 单次调用同波派发 2 个 researcher，两条 `role_task` 时间窗重叠（并发实证，非顺序）；chain step2 回显 step1 产出的 token（`{previous}` 传递）。
  - **上下文隔离**：父对话含暗号 `ZEBRA-42`，子任务简报不含暗号，子代理枚举所见上下文为 `NO_PRIOR_CONTEXT` 且输出无暗号。
  - **工具白名单 + 深度上限 1**：researcher 子代理自报工具集实测仅 `read,grep,find,ls`（清单外工具不存在）；子代理内再派发 `task` 被拒（`TOOL_NOT_AVAILABLE`）。
  - **权限继承**：`default` 模式下子代理 `bash` 重定向命令被评估为 ask → 以合成 id `subagent-*` 转发父会话 UI 通道（label 带角色名），裁决 deny 后命令未执行（探针文件缺席），审计落 `child-permission`；`bypass` 模式下同一命令无弹窗直接执行（探针文件存在，验收后清理）。
- ✅ 本次走查修复 1 个真实 bug：子代理以 PI 的 session-file uuid（`ctx.sessionManager.getSessionId()`）寻址父会话，而 worker 会话表以 kernel SessionId 为键——两个 id 空间不相交，寻址落空使**所有子代理工具调用被拒**（"the parent session ended while the child was running"），且 `role_task` 成本记到一个不属于任何会话的 id。修复：新增 `src/main/agents/parentLookup.ts`（双 id 空间解析），`worker.ts` 的 `forwardChildPermission` 与 `observeChildRun` 两处接入；回归覆盖 `tests/multiAgentParentLookup.test.ts`（5 例）+ 验收脚本 `single`（role_task 归属）与 `perm-default`（`subagent-*` 转发）阶段。
- ⚠️ 仍未端到端走查（超出本工单范围）：swarm peer 领取循环。
