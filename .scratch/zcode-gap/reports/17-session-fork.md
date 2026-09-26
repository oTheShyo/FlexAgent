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

- **未跑 app 内 e2e**：分叉的端到端（真实会话里点 Fork → 新会话落地）需 dev server + 窗口；纯逻辑（截断/匹配/header 重写）由 9 项单测覆盖，worker/IPC 接线按既有 createSession 模式镜像但未运行时验证。
- **分叉点匹配依赖 `{ts, prefix}`**：prompt 前 64 字若有重复（同一会话两次相同开头）且 transcript 无时间戳，会取**最后一次**命中——已在测试中固化该行为（last-match）。
- 分叉会话的 PI 文件 id 与源不同、`parentSession` 指向源（PI 血缘），但内核 sessionId 由 ipc 侧 `randomUUID()` 新生成——两套 id 各自独立（与工单 03 的双 id 空间修复同源的注意点）。
