# 可观测性（v2.1）

> 设计来源：Alice 工程方法论第 13 章（Agent 可观测性），落地方案讨论见 2026-09-25 会话。
> 核心立场：**不可观测的系统等于黑盒**；但 FlexAgent 是本地单机桌面应用，不需要 OTel collector。

## 1. 结论

FlexAgent 已有两块地基：`KernelEvent` 会话级事件流（contract，带 per-session seq 保证有序）和
`perf.ts` attach 专项打点（`FLEXAGENT_PERF=1`）。缺的不是接入外部观测系统，而是：

1. **把事件流落盘**（现在用完即弃，事后无法还原）；
2. **调用来源（callSource）**——回答"token 花在哪、调用为什么发生"；
3. **权限等待 / 工具执行时间分离**——不分离的话审批模式下的性能指标全是假象。

## 2. 现状与差距

| 能力 | 现状 | 差距 |
|---|---|---|
| 事件流 | KernelEvent 全量流到 renderer | 未持久化 |
| 性能打点 | `perf.ts` 仅覆盖 attachSession / createSession / warmup | LLM 调用、工具执行、压缩无打点 |
| 成本归因 | 无 | 回答不了"钱花在哪" |
| 权限等待 | PermissionDialog 等待时间混在工具耗时里 | 性能指标被污染 |
| 错误降级 | 只认 `KERNEL_INTERNAL` | 缺调用上下文 |
| 会话检索 | LIKE 扫描（未上 FTS5） | 无事件级查询（暂缓，见 §7） |

## 3. 数据脊柱：一条 NDJSON 事件流

**观测流与 UI 事件流解耦。** `KernelEvent` 继续负责 renderer 实时性；观测 sink 在 worker 的
`emit()` 出口把事件追加落盘：

```
~/.flexagent/sessions/<sessionId>/events.jsonl
~/.flexagent/observability/llm-calls.jsonl   ← 无 sessionId 归属的 worker 侧 LLM 调用
```

- 逐行 JSON 追加（`appendFileSync`），进程崩溃只丢最后一行——与 `skill-writes.jsonl` 同一写法。
- **trace 语义靠现有字段**：`sessionId`（每 Agent 实例唯一 ID）+ run/turn 事件序列即天然 span 树，
  不引入 span 模型。
- metrics 不建独立系统：从 NDJSON 离线聚合。

### 3.1 默认记录 vs Debug 模式

| 模式 | 记什么 | 开关 |
|---|---|---|
| 默认 | 元数据：时间、事件类型、工具名、耗时、错误码、callSource、token 计量 | 零配置 |
| Debug | 完整 args / 工具结果摘要 /（后续）prompt 与 response 全文 | `observability.debugLlm: true`（settings.json，2s 内生效）或 `FLEXAGENT_DEBUG_LLM=1` 强制 |

与权限系统同一哲学：**默认保守，显式放宽**。System Prompt 全文不进默认日志。
Settings 面板的 UI 开关待接（contract/ipc/preload 正被并行轨道改写，避免叠 hunk）；
后端键已生效，手改 settings.json 即可用。

### 3.2 必须分离的两段时间

`tool_end` 新增可选字段（contract 只增不改）：

- `execMs` — 工具真正执行的墙钟时间（`tool_execution_start` → `tool_execution_end`）。
- `waitMs` — 等待用户在 PermissionDialog 上拍板的时间（`permission_request` 发出 → 决议到达）。

流式 LLM 的 span 终点取**最后一个 token**：在此之前是否调用工具尚未确定，性能分析才有意义。

## 4. 调用来源（callSource）

每次 LLM 调用标注发起目的，写入 llm-calls.jsonl：

| callSource | 发生位置 | 观测方式 |
|---|---|---|
| `chat` | PI 内核 agent loop → `message_end` 事件 | ✅ assistant 消息自带 `usage`/`provider`/`model`，worker 在 message_end 观测（duration = 消息时间戳 → 事件 ts，即 §3.2 的最后一个 token） |
| `compaction` | `session_before_compact` → `compactionRouting.ts` | ✅ 本次接入 |
| `permission_classifier` | `classifyBash`（权限链第 4 层） | ✅ 本次接入 |
| `memory_dedupe` | `judgeMemoryDuplicate`（记忆去重小模型） | ✅ 本次接入 |
| `role_task` | 子 agent 一次 `task`/`swarm` 执行的**账本**，非单次调用 | ✅ 本次接入。子会话跑在 inMemory session 上、回报父会话前已 dispose，其 `chat` 调用不会经过父的事件流，所以只能由 `runChild` 在 finally 里一次性上报 `role` / `turns` / `toolCalls` / `tokens` / `cost`。字段取不到时**省略而不写 0**——读到 0 会被误读成"这次委派没花钱" |

离线聚合：`node scripts/obs-report.mjs [--dir <obsHome>] [--hours <n>]` —— 按 callSource 汇总
token/成本/时长、按工具分离 exec vs wait、管线成败与最近失败原因、内核错误码分布。

没有这个字段时只能看到"过去 24h 消耗了 N token"；有了它才能回答：

- **成本归因**：压缩类调用占比突然升高 = 工具输出变大或对话变长；
- **性能诊断**：分类器调用频繁 = 用户频繁触发权限判断；
- **行为异常**：压缩日志是排查"FlexAgent 忘了之前说的话"类反馈的唯一抓手
  （Alice 的真实案例：压缩把用户关键需求当低价值内容丢掉，靠压缩日志定位）。

## 5. 归因映射：已知故障 → 需要的数据

| 已知故障 | 观测数据 |
|---|---|
| 模型写盘成功但内核不生效 | kernelWarning + llm-calls 链路对齐 |
| undici 超时重试（Skill Hub ~1/3 失败） | 安装 pipeline 事件 + 重试计数（待接入） |
| 代理导致 Electron fetch 全挂 | 启动 marks + 网络错误事件（待接入） |
| 后台重活拖慢飞行中请求 | warmup `skipped: 'ui busy'`（perf 已有）+ llm-calls 时间线比对 |

## 6. 启动性能

cold start ~5.2s（worker 冷启动 + PI ESM 图首次 import，不可省）。`perf.ts` 已覆盖
attachSession / createSession / openSession / warmup / listModels 的分段；
main 进程启动 marks（module load → registries → kernel start → window loaded）
也已接入，`FLEXAGENT_PERF=1` 打印 `[perf] startup {…}`。通用打点走事件流。

## 7. 明确不做

- **不上 OTel SDK / Prometheus / Jaeger**：单机桌面应用，OTel 的 span 生命周期与上下文传播
  模型为微服务设计（流式终点、IPC 传播、维度基数三个不匹配），NDJSON + 离线聚合够用。
- **不重写 perf.ts**：保留为启动/attach 专项。
- **FTS5 暂缓**：事件查询先走现有 LIKE 扫描路径，等会话量级实测再定。
- **Sampling 不做**：Agent 的每次对话都是独特的，比例采样会丢关键调试信息；
  默认元数据-only 已经是成本控制手段。

## 8. 实现（v2.1 已落地部分）

| 件 | 位置 | 说明 |
|---|---|---|
| 观测 sink | `src/main/observability.ts` | `observeEvent` / `observeLlmCall` / `observePipeline`，NDJSON 追加，写失败静默（观测不能拖垮业务） |
| sink 接线 | `src/main/worker.ts` `emit()` | 所有 KernelEvent 出口处落盘 |
| execMs / waitMs | contract `tool_end` 可选字段 + worker 计时 | 权限等待与执行分离（含 subagent 合成 id 路径） |
| callSource | `compactionRouting.ts` 可选 `observe` dep + worker 侧包装 | compaction / permission_classifier / memory_dedupe |
| callSource | `multiAgent.ts` `observeChildRun` → worker 侧 `observeLlmCall` | role_task（子 agent 账本，`role` 字段归因到角色） |
| 启动 marks | `src/main/index.ts` | module load → registries → kernel → window loaded，`[perf] startup {…}` |
| Skill Hub 管线 | `skillHub.ts` `retryTransient` + `installSkill` 包装 | 每次传输重试 / HTTP 状态拒绝 / 安装成败落 `pipeline.jsonl` |
| Debug 开关后端 | `observability.ts` `isDebugLlm()` | settings.json `observability.debugLlm`（TTL 2s）+ 环境变量强制 |
| `chat` callSource | `worker.ts` `observeChatMessage()` @ `message_end` | assistant 消息的 usage/model 直接观测，含 tokens 与 cost |
| 离线聚合 | `scripts/obs-report.mjs` | callSource 成本/工具 exec-wait/管线失败/错误码，`--hours` 过滤 |

**待办（按优先级）**：① Debug 开关的 Settings UI（后端键已生效；等 contract/ipc/preload 并行改写
安定后接线，不做手改 JSON 之外的临时 UI）；② Skill Hub 之外的管线（marketplace 归档）复用
`observePipeline`；③ FTS5 事件查询（等会话量级实测）。
