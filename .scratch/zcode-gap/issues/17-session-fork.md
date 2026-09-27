# 17: 会话分叉

**What to build:** 在一条稳定完成的助手消息上提供"分叉"操作：以该消息为起点创建新会话，继承分叉点之前的对话历史与当时的配置（模型、推理强度），原会话完整保留继续运行。语义边界写清楚：只影响对话历史，不回滚磁盘文件（两个会话操作同一工作区）；被中断/失败的半截回复、用户消息、工具结果没有分叉入口；新会话标题为派生标题并带"从对话中派生"标记；待发送队列、后台任务不复制。

**Blocked by:** 01 (落库未提交子系统), 12 (会话重命名/归档后端)

**Status:** done (实现 `821fad9`；2026-09-27 端到端复核发现并修掉一个真 bug，见下)

## E2E（2026-09-27，真实应用 + 真内核 + 真实 transcript）

之前的 `done` 只到"结构上成立"：9 项单测覆盖纯逻辑，worker/IPC/UI 接线按既有模式镜像，**没有在跑起来的应用里点过一次 Fork**。本轮补上，脚本 `scripts/diag-session-fork.mjs`（四阶段，主工作区 `npm run dev` + CDP）：

| 阶段 | 做什么 | 结果 |
| -- | -- | -- |
| `create` | 在一条真实会话（133 条目）的**中段**分叉，逐项核对产物 | 16/16 |
| `verify` | **重启应用**（worker 会话表清空 → 只能走磁盘冷加载）后打开分叉、断言 UI 入口 | 18/18 |
| `click` | 在 UI 上**真点**第 4 条助手消息的 Fork 按钮，走到新会话落地 | 21/21 |
| `cleanup` | 删掉临时分叉，核对源会话与列表条数 | 6/6 |

实测数据：分叉点取第 53 条 → 保留 54 / 丢弃 79（前两次仓库里真实存在的分叉都是"分叉点=末条"，一行没截，所以**截断这件事在本轮之前从未被真跑过**）；点击路径保留 33/133。源 transcript 在四个阶段前后 sha256 一致（`5cd69544529f82ba`）。重启后冷加载回放出 22 条消息 = 前缀应有条数。

### 复核揪出的真 bug（已修）

侧栏的 `fork` 徽章一旦打开该会话就消失。根因不在渲染端：`ipc.openSession` 手搓了一个 `summary` 字面量，漏掉 `archived` 与 `derivedFrom`；而 `useChat.openSession` 是拿 `detail.summary` **整条替换**侧栏行的（`useChat.ts:545`）。同一个漏掉的 `archived` 还有第二个后果：打开一个已归档会话，它会立刻回到普通列表。

修法是不再让 summary 有第二个来源：`toSessionSummary` 抽成纯模块 `src/main/sessionSummary.ts`，`registry` 与 `ipc` 都走它（`ipc.ts` 三处字面量全部删除）。回归 `tests/sessionSummary.test.ts`：7 项行为断言 + 一条"ipc 不得手搓 summary"的源码护栏。

**这是只有真机走查能发现的缺陷**——单测覆盖不到 ipc 与渲染端的这条缝。

### 仍未闭环

- 打开一个**归档**会话不再掉标记，与徽章同因同治；但"归档态 + 分叉态"同时存在的界面表现没有单独走查。
- 走查中发现 `deleteSession` 只删注册表行，**PI 转录文件留在盘上且失去唯一指针**（`ipc.ts:383-402`）。与 17 无关，单独记在工单 29，本工单不动它。

- [x] 稳定完成的助手消息上出现分叉入口；不稳定消息/用户消息/工具结果无入口 — UI 实测：10 个入口 / 10 条助手行，用户行 0、工具行 0；文案含 "Disk files are not touched"。（历史回放里工具结果不产生行，故"工具行无入口"由单测覆盖）
- [x] 分叉产生的新会话：历史截至分叉点、配置继承、标题与派生标记正确 — 保留 54/133（真截断）、header.id 换新、`parentSession` 指向源 PI 会话、标题 `源标题 · fork`、重启后徽章仍在
- [x] 原会话不受影响，可继续正常运行 — 源 transcript 四阶段 sha256 恒定；分叉后源行仍在侧栏且可继续打开
- [x] 分叉不回滚磁盘文件的语义在 UI 或提示中可见 — ForkButton 的 title 文案（实测取到原文）
- [x] 队列/后台任务不复制到新会话 — 新会话 `runState: idle`、回放历史等于前缀、无 pending 队列
- [x] 与注册表持久化兼容：重启后分叉会话仍在（继承工单 12 的持久层） — 杀掉进程重启后冷加载 22 条消息，与磁盘前缀逐条一致

## Scouted（编排会话 2026-09-26 侦察地图，文件/行号已核verified）

- **注册表**（ticket 12，DONE）：`src/main/registry.ts` — `RegistryRecord {id, title, cwd, createdAt, updatedAt, runState, piSessionFile?, archived?, renamedAt?}`；`registryPath()` = userData/sessions.json；`defaultTitle(cwd, title)`（MAX_TITLE 80）；`preserveCorrupt` 备份。分叉 = 新 RegistryRecord + 派生标题 + 建议加 `derivedFrom?: {sessionId, messageId}` 可选字段（PersistShape version 1 加性）。
- **PI 会话文件采用**：`SessionManager.open(path, sessionDir?, cwdOverride?)`（session-manager.d.ts:369）——worker `setSessionCwd` 已用（worker.ts 2235-2241）。分叉实现：复制父 `piSessionFile`（JSONL SessionEntry）→ 截断分叉点之后的条目 → `SessionManager.open(copiedFile, undefined, cwd)`。
- **会话创建**：worker `case 'createSession'`（~2137-2152）→ `attachSession(sessionId, cwd, sessionManager)`（2127 setupPermissionGate）；配置继承 = 创建后对 host.session `setModel`/`setThinkingLevel`（2418 handler 模式，persist: false）。
- **消息 id 映射**：worker `message_end` emit（1770-1777：`{type, ...meta, message: chat}`）——查 meta 里的 entry id；renderer useChat ChatItem id 从事件来。分叉点 = 稳定完成的 assistant 消息的 entry id。
- **渲染端**：`ChatView.tsx` — ChatItem（useChat）；CopyButton memo 模式（75 行+，icons from './icons'）；分叉入口只放稳定完成的 assistant 行；调用 codexApi 新方法 → IPC → main → worker。
- **IPC 链模式**：`permissionRulesIpc.ts`（ipcGuard + ipcMain.handle，从 index.ts 注册）→ preload invoke 面（161-181）→ src/renderer/src/api。
- **队列/后台任务**：worker/App 按会话持有——新会话天然没有；验证无复制即可。
- **测试模式**：tests/*.test.ts（vitest）；分叉的纯逻辑（历史前缀截断 + 注册表记录）可无 app 测试（registry.ts 模式 + JSONL 解析）。
