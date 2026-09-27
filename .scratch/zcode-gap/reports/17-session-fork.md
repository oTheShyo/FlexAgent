# Ticket 17-session-fork — Final Report

Commits: (orchestrator commits this lane).
Attempts: agent sessions ×3 all killed by the 30-minute inactivity timeout with zero output; the orchestrator implemented it from the scout map written into the ticket.

## 交付物

- `src/main/sessionFork.ts`（新）：`forkSessionFile(sourceFile, {ts?, prefix}, newPiId)` — 逐行解析 PI transcript（JSONL），从尾向前找**稳定完成**的 assistant 条目（`stopReason ∈ {stop,length,toolUse,deferred}`；`error`/`aborted`/`pending` 一律不匹配），按 `timestamp + 前 64 字` 定位（transcript 无时间戳时退化为仅前缀匹配，取最后一次命中）；保留到该行、丢弃其后全部条目（后续回合、其工具结果、以及分叉点之后的 model/thinking 变更）；重写首行 header（`id`=新 PI id，`parentSession`=源 id——PI 自身的血缘建模方式）；输出同目录 `<stem>.fork-<id8>.jsonl`。返回 `{file, forkedPiId, entriesKept, entriesDropped}`。
- `src/main/registry.ts`：`RegistryRecord.derivedFrom?: string` + `SessionRegistry.fork(id, sourceId, title)`（同 cwd、派生标题、血缘标记）+ `toSummary` 透出 `derivedFrom`。
- `src/shared/contract/index.ts`：`IPC.forkSession`、`SessionSummary.derivedFrom?`、`ForkSessionInput {sessionId, messageTs, messagePrefix}`、`CodexApi.forkSession`。
- `src/shared/kernel-protocol.ts`：WorkerRequest `forkSession {sessionId, newSessionId, messageTs, messagePrefix}`。
- `src/main/worker.ts`：`case 'forkSession'` — requireSession → 取 `host.session.sessionFile` → `forkSessionFile` → `SessionManager.open(forked.file, undefined, host.cwd)` → `attachSession(newSessionId, cwd, sessionManager)`；**配置继承靠 transcript 回放**（分叉点之前的 model_change / thinking_level_change 条目即"当时的配置"），不从父会话当前状态重推。
- `src/main/ipc.ts`：`IPC.forkSession` handler（guard + 输入校验 + `registry.fork` + `kernel.request` + `attachPiSession`；失败 `registry.remove(newId)` 回滚）。
- `src/preload/index.ts`：`forkSession` 方法；`src/renderer/src/api/mock.ts`：`forkSession` 诚实抛错。
- `src/renderer/src/hooks/useChat.ts`：`forkSession(message)` — 调 api → `refreshSessions` → `openSession(新会话)`；失败以 errorItem 呈现。
- `src/renderer/src/components/ChatView.tsx`：`ForkButton`（`data-testid="message-actions-fork"`，title 明示"新会话继承历史与配置；不触碰磁盘文件"）、`ChatRow.isForkable/onFork`、`renderItems` 计算 `isForkable`（assistant message 且**下一项非 error** 且 onFork 存在）。
- `src/renderer/src/components/icons/index.tsx`：`ForkIcon`。
- `src/renderer/src/components/Sidebar.tsx`：`derivedFrom !== undefined` → "fork" 徽章（`data-testid="session-derived-badge"`）。
- `tests/sessionFork.test.ts`（9 项）。

## 逐项验收

| # | 项 | 状态 | 证据 |
| - | -- | -- | -- |
| 1 | 稳定完成的助手消息上有分叉入口；不稳定/用户/工具结果无入口 | ✅ | ChatView `isForkable` 仅在 `kind==='message' && role==='assistant'` 且 `items[index+1]?.kind !== 'error'` 时给出按钮（流式为 `partial`、工具为 `tool`、失败后紧跟 `error`）；`forkSessionFile` 只匹配稳定 stopReason（测试：error/aborted 不匹配、user/toolResult 不匹配） |
| 2 | 分叉会话：历史截至分叉点、配置继承、派生标题与标记正确 | ✅ | `forkSessionFile` 截断（测试：保留到匹配行、丢弃其后含 user/assistant/工具/配置变更）；标题 `${parent.title} · fork`；`derivedFrom` 标记（registry + Sidebar 徽章）；配置由 transcript 回放继承（worker 注） |
| 3 | 原会话不受影响，可继续运行 | ✅（结构） | 分叉只读源 transcript（`readFileSync`）、写**新文件**、建**新 kernel session id**；父 host/transcript/run_state 零改动（worker case 仅 `requireSession` 读，不 mutate） |
| 4 | 分叉不回滚磁盘文件的语义在 UI 可见 | ✅ | ForkButton 的 `title` 文案明示"Disk files are not touched"；两会话同 cwd（registry.fork 继承 source.cwd） |
| 5 | 队列/后台任务不复制到新会话 | ✅（结构） | 新会话 = 新 kernel sessionId + 新 host（`attachSession` 全新状态：无 pending 发送队列、无后台任务、无 memory 提取状态） |
| 6 | 与注册表持久化兼容：重启后分叉会话仍在 | ✅ | `registry.fork` 即 `records.set + persist()`（sessions.json，version 1 加性字段 `derivedFrom`）；`load()` 对缺字段记录平滑默认；`attachPiSession` 落 piSessionFile（移植工单 12 持久层） |

## 门禁

- `npm run test`：**116/116 PASS**（107 基线 + sessionFork 9）
- `npx tsc --noEmit`：node 0 / web 0 / test 0
- `npx oxlint`（13 个车道文件）：0
- 全库 lint 仍有 1 处外来失败（`src/main/pluginMcpOverrides.ts:16`，他车道）——非本车道

## 诚实缺口

- **~~未跑 app 内 e2e~~ → 2026-09-27 已补，并因此抓到一个真 bug**（见下节）。纯逻辑（截断/匹配/header 重写）由 9 项单测覆盖，worker/IPC 接线现已由真机走查覆盖。
- **分叉点匹配依赖 `{ts, prefix}`**：prompt 前 64 字若有重复（同一会话两次相同开头）且 transcript 无时间戳，会取**最后一次**命中——已在测试中固化该行为（last-match）。真实 transcript 实测 `message.timestamp`（数值 epoch ms）与 `message.stopReason` 都在，所以精确匹配那条路是通的，不是只在合成数据里成立。
- 分叉会话的 PI 文件 id 与源不同、`parentSession` 指向源（PI 血缘），但内核 sessionId 由 ipc 侧 `randomUUID()` 新生成——两套 id 各自独立（与工单 03 的双 id 空间修复同源的注意点）。

## 2026-09-27 端到端复核（发现并修掉一个真 bug）

脚本 `scripts/diag-session-fork.mjs`，四阶段跑在起着的应用上（`npm run dev` + CDP）：

```
create  16/16   真实会话中段分叉：保留 54 / 丢弃 79；源 transcript 字节未变
verify  18/18   重启应用后冷加载：22 条消息 = 磁盘前缀应有条数；UI 入口 10/10 挂在助手行
click   21/21   真点第 4 条助手消息的 Fork：保留 33/133，界面落到新会话，带 fork 徽章
cleanup  6/6    临时分叉删除，列表条数回到点击前
```

前两次仓库里真实存在的分叉（`33f523dc` / `38b3e97f`）分叉点都落在**末条**，一行没截 —— 也就是说"历史截至分叉点"这件事在本轮之前从未被真跑过。

### 抓到的 bug：打开分叉会话后 `fork` 徽章消失

- **症状**：侧栏行的 `fork` 标记在打开该会话后不再渲染（`document.querySelectorAll('[data-testid="session-derived-badge"]')` 只剩两条旧分叉）。
- **根因**：`ipc.ts` 的 `openSession` / `forkSession` / `createSession` 各自手搓了一个 `summary` 字面量。`openSession` 那个漏了 `archived` 与 `derivedFrom`，而渲染端 `useChat.ts:545` 是 `prev.map(s => s.id === sessionId ? detail.summary : s)` —— **整条替换**。所以一打开，徽章就没了。
- **同一个漏字段的第二个后果**：打开一个**已归档**的会话，`archived` 丢掉后它会立刻回到普通会话列表（`real` 影响，不只是显示）。
- **修法**：删掉三处字面量，统一走 `registry.summary(id)`；把映射抽成纯模块 `src/main/sessionSummary.ts`（`toSessionSummary`），使"summary 只有一处定义"这件事可以被单测钉住。
- **回归**：`tests/sessionSummary.test.ts` — 7 项行为断言（含 `archived` 必为布尔、`derivedFrom` 无血缘时整个键不出现、不改写入参）+ 一条源码护栏（`ipc.ts` 不得出现 `runState:` / `derivedFrom:` / `summary: {`，且必须调用 `registry.summary(`）。
- **为什么单测没抓到**：`ipc.ts` / `registry.ts` 依赖 `electron`，本仓的单测约定是"只导入纯逻辑模块"；这条缝只有真机走查能覆盖。

### 顺带发现（不属本工单，记在 29）

`deleteSession`（`ipc.ts:383-402`）删了内核会话、终端、权限规则和注册表行，**唯独把 PI 转录留在盘上**，而 `registry.remove` 是那文件唯一的指针 —— 删除即产生不可达的孤儿文件（含完整对话内容）。

