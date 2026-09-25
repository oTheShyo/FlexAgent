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
- ⚠️ 未做端到端走查（需真实模型调用）：`task` 工具真实派发、权限转发弹窗链路、peer 领取循环。建议后续 `qa-multi-agent.mjs` 走查。
