# 工程范式审查（对标 Alice ch.15）

- 来源：https://alice.miyang.cn/methodology/chapter.html?ch=15-engineering-patterns（十二个可迁移工程范式）
- 审查范围：FlexAgent 主进程 + 契约层（`src/main/**`、`src/shared/**`）
- 日期：2026-09-26

## 结论先行

| 判定 | 数量 | 范式 |
|---|---|---|
| 强落地 | 5 | 一 契约、五 最小权限、七 可撤销、八 可观测性、十一 接口稳定 |
| 部分落地 | 4 | 二 事件流、六 懒加载、九 读写分离、十 分层记忆 |
| 真缺口 | 3 | 三 分层压缩、四 互斥守卫、十二 防呆（部分） |

三条真缺口里只有 **范式三（分层压缩）** 是功能性的——它直接影响长会话可用性。
范式六（MCP 预连接）是最容易修的一条，改动面小、可测、收益直接落在首消息延迟上。

整体判断：权限链、可观测性、可撤销这三块的质量**高于**文章的一般期待（每处都写了"为什么这样排"的代价论证），
它们不是"实现了功能"，而是把设计取舍写进了代码注释。相比之下，围绕"上下文"这条主线
（压缩、记忆、事件流）的范式落地最薄——**因为主线大部分在 PI 内核手里，项目只做了贴附层**。

## 逐条判定

| # | 范式 | 判定 | 项目里的证据 | 缺口 |
|---|---|---|---|---|
| 1 | 声明式契约优于函数 | 强 | `permissionGate.ts:51-98` READ/WRITE_TOOLS 是**数据**不是分支；`multiAgent.ts:259` 角色并行性靠声明；MCP 工具描述符带 description/parameters（`worker.ts:575-579`） | MCP 与插件工具没有 `readOnly` / `concurrentSafe` 元数据，契约信息被丢在专家（保守 ASK）。契约元数据的消费者仍靠名字猜 |
| 2 | 事件流作为系统边界 | 部分 | 内核事件在 worker 的**单一 emit 出口**被 `observeEvent` 消费（`observability.ts:149`）；NDJSON 落盘；`META_KEYS` 白名单即默认流 | 子 agent 的事件流**没有** merge 进父流（`multiAgent.ts` 只收一份 report 文本）；无重放工具，events.jsonl 只能读不能重放 |
| 3 | 分层压缩策略 | **缺口** | 只有"路由到更强模型"这一层昂贵策略（`compactionRouting.ts:137`） | 无本地裁剪层；全库检索 `auto_threshold` **零命中**，自动压缩阈值未配置 → 长会话按内核默认（关闭）处理 |
| 4 | 互斥守卫防递归 | **缺口** | 记忆写入延迟到 turn_end 批量提交（`selfEvolution.ts`）；热身用 `waitForQuiet`（`worker.ts:185`） | 这两条是**防竞争**不是防递归。没有看到"压缩 → 触发写入 → 再触发压缩"这类闭环的显式守卫 |
| 5 | 最小权限结构化 | 强 | 5 层责任链（`permissionGate.ts:1-27` 头注逐层说明代价不对称）；credential 边界**高于** rules 与 session memory（`:427-434`、`:627`）；每次决策带 `via` + `reason` | 无显著缺口。这是全项目最好的一块设计 |
| 6 | 懒加载防启动雪崩 | **部分/反面** | `ensureMcpHandle`（`worker.ts:478`）保留了懒连能力 | 实际路径是**启动即并行全连**：`startMcpToolBridge`（`:602-619`）对全部 server 跑 `Promise.allSettled`；`MCP_ATTACH_GRACE_MS=3000`（`:143`）是超时降级，不是懒加载。首个 MCP 工具延迟 = 最慢 server |
| 7 | 可撤销的不可逆操作 | 强 | `skillHistory.ts:24-25` undo log 路径与 5 版上限；`skillManage.ts:342+` **写入前**快照 `previousContent`；重启后仍可撤（`:169-172` 注释） | 撤销只覆盖 skill 写入。其余 AI 改持久化状态（memory 卡片、models.json）无快照 |
| 8 | 细化的可观测性 | 强 | `observability.ts:82-86` `callSource` 四类来源；pipeline 单独一条流（`:167`）；debug 开关带 2s TTL（`:39-58`） | 缺子 agent 来源维度；缺离线聚合脚本（现有 `scripts/obs-report.mjs` 未入库） |
| 9 | 读写分离并发安全 | 部分 | `inflightMcpCalls` 有界（`worker.ts:194`）；`multiAgent.ts:441` "reads before writes"；`swarmQueue` 有 claim | 工具的并发安全性项目侧未声明，实际由内核 PI 决定；项目的 READ/WRITE 分类只服务于权限，没有第二份并发元数据 |
| 10 | 分层记忆对应生命周期 | 部分 | 三层已在用：MEMORY.md 卡片（跨会话，budget 40，`selfEvolution.ts:42`）、`recallHistory` 短期召回（`:278-283`）、skill usage 年龄信号 | 无向量库 / SQLite / 用户画像层；层级是"够用"而非"设计过的分层"，缺冷层 |
| 11 | 接口稳定实现可丢弃 | 强 | `userModels.ts:15-26` 头注三条安全规则（外科手术式写、镜像内核校验、不移动密钥）；`shared/contract` + `kernel-protocol` 四方契约 | 无显著缺口。`models.json` 的写路径是范式十一的标准样板 |
| 12 | 防呆优于依赖正确性 | 部分 | classifier 连续 3 次拒绝→交回人（`permissionGate.ts:486,509`）；`HARD_DENY` bypass 下仍拒绝（`:157`）；compact 失败回落 session model（`compactionRouting.ts:157-168`）；MCP 重名告警（`worker.ts:637-642`） | 防呆集中在权限侧。上下文侧（压缩/记忆）缺"模型没按格式输出"这类兜底 |

## 三条真缺口的展开

### 3.1 分层压缩只有昂贵那一层（范式三）

现状是单策略：`session_before_compact` 里如果配了 compaction model 就换强模型跑一次 `compact()`，
没配就原样交回内核（`compactionRouting.ts:91-100`）。没有任何**廉价层**——
没有"先本地裁掉超长 tool 输出 / 掉低优先级消息"这一步。

文章给的公式是「低占用 → 廉价策略 → 中占用 → 轻量 API → 接近上限 → 强力 API」。
现在项目直接从"什么都不做"跳到"换模型"，中间两层都没有。

附带事实：`compaction.auto_threshold` 在整个 `src/` 里零命中（我 grep 过），
也就是说自动压缩的触发阈值由内核默认值决定。这需要实测确认内核默认值，
**我没验证**，但"项目层没有为它写过任何东西"是确定的。

修复方向（按成本排序）：
1.  cheapest：在 hook 里对 `event.preparation.messages` 做本地裁剪（截断超长 tool 结果），
   再交给 `compact()` —— 全部无 API 成本。
2. 中间层：本地裁剪后仍超预算时，才调 `compact()` 用原会话模型。
3. 昂贵层：现有 routing 逻辑不动。

风险：`event.preparation` 的结构是内核内部面，裁剪写错会丢消息。
需要先写断言脚本固定"裁剪是可逆的/只碰超限部分"。

### 3.2 MCP 预连接（范式六）

`startMcpToolBridge` 在资源规格到达时就并行连全部 server。注释（`:612-615`）解释了为什么**并行**：
单个 npx 起的服务 5.9–6.9s，串行不可接受——这个论证是对的。但文章的点在另一处：
「注册时只保存配置，第一次调用时才建立连接」，代价不该由启动承担。

现在的设计下，成本被转到两处：
- 首消息延迟 ≥ 最慢 server（3s grace 之外的部分被静默丢掉，工具注册表缺工具）；
- `mcpDeferredLoader` 那条分支（`:656-661`）说明"attach 早于 bridge 完成"是常态而非异常——
  这本身就是启动流程在打补丁的证据。

修复方向：把 `mcpHandles`（`:152`）作为唯一连接入口，`mcpToolRegistry` 里的工具先标记 `unconnected`，
调用时再 `connectMcpClient`；`mode="status"` 已具备报未连能力（`:318`）。
首个调用会變慢，但只有那一个 server。

### 3.3 上下文侧的互斥守卫（范式四）

权限链（范式五）的工程质量是因为它显式处理了"谁在什么时候说了算"。
上下文侧没有对等的东西：压缩会消耗 token（可能再触发压缩），
记忆写入发生在 turn_end，skill 写入是原子的——但三者之间没有"同一时刻只有一个上下文改写者在写"的约定。
`waitForQuiet`（`worker.ts:185`）管的是 UI 请求与预热的关系，管不到这些。

这是最难验的一条，也是**优先级最低**的一条：没有观察到实际递归事故。
记录为已知缺口，不是待修 bug。

## 建议动手顺序与执行结果

| 优先级 | 项 | 范式 | 状态 |
|---|---|---|---|
| P3 | callSource 加子 agent 维度 | 八 | **已落地**（2026-09-26） |
| P1 | MCP 改为按需连接 | 六 | **未动 —— 本机零收益** |
| P2 | 压缩加本地裁剪便宜层 | 三 | **未动 —— 无数据可验** |
| P4 | 工具元数据加 readOnly/concurrentSafe | 一 + 九 | **未动 —— 无落点** |

### P3 落地内容

- `observability.ts`：`CallSource` 加 `'role_task'`，`LlmCallObservation` 加 `role` / `turns` / `toolCalls`。
- `multiAgent.ts`：`MultiAgentDeps.observeChildRun`，`readChildLedger()` 用内核 `getSessionStats()`
  取 tokens/cost/轮次；在 `runChild` 的 **finally、dispose 之前**上报（stats 随 session 一起失效）。
- `worker.ts`：把账本转成 `observeLlmCall({ callSource: 'role_task', ... })`，归到父会话 id 下。
- `scripts/child-run-observability-check.mjs`：16 条断言全绿。

两处值得记下的教训：

1. 我第一次做负向验证是**无效的**。`observeLlmCall` 把入参整体展开写盘，所以把 `role?: string`
   改成 `role?: never` 后脚本照样全绿 —— 类型定义不影响运行时产物。这条通道真正的守卫是 `tsc`
   （去掉字段或调用点，`tsc` 立刻红），脚本负责的是 sink 契约与"上报点还在不在"。
2. 第二条教训来自修第 1 条：源码断言 `/role: role\.name/` 会被**注释掉的同名行**满足，
   负向验证因此假通过。收紧成 `/^[ \t]*role: role\.name,[ \t]*$/m` 后才真的会 FAIL。

### 为什么 P1 / P2 / P4 没动

- **P1**：`~/.flexagent` 在本机不存在，`pluginResourceSpec.mcpServers` 为空 —— 一条 MCP server 都没配。
  `startMcpToolBridge` 此刻什么都不连，改动只能改善一个还不存在的场景，还会给工具引入
  "可见性窗口"（connect 完成前模型看不到工具）。为假想问题付工程成本，不做。
- **P2**：`compaction.auto_threshold` 在项目层零命中，自动压缩按内核默认走；本地裁剪要动
  `event.preparation`（内核内部面），且本机无长会话可验证。等真正出现"上下文撑不住"的现场再动。
- **P4**：工具并发调度在 PI 内核手里，项目侧只能影响自己的工具与角色声明——而角色 `readOnly` /
  `parallelWith` 已经在 `roles.ts` 里做了。内核层加元数据没有落点。

## 未验证的部分

- 内核 `compaction.auto_threshold` 的默认值（只知道项目层零命中）。
- 多 agent 子会话的实际事件流走向（`multiAgent.ts` 只 grep 到 `sessionId` 与 report 相关行，
  子 agent 事件是否经 worker 落盘未确认）。
- 范式十的冷层：现存项目里没有向量库/SQLite，所以"分层"目前只有三层，是否要补第四层取决于是否做语义检索。
