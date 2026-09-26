# 17: 会话分叉

**What to build:** 在一条稳定完成的助手消息上提供"分叉"操作：以该消息为起点创建新会话，继承分叉点之前的对话历史与当时的配置（模型、推理强度），原会话完整保留继续运行。语义边界写清楚：只影响对话历史，不回滚磁盘文件（两个会话操作同一工作区）；被中断/失败的半截回复、用户消息、工具结果没有分叉入口；新会话标题为派生标题并带"从对话中派生"标记；待发送队列、后台任务不复制。

**Blocked by:** 01 (落库未提交子系统), 12 (会话重命名/归档后端)

**Status:** done (committed this lane; report: reports/17-session-fork.md)

## Scouted（编排会话 2026-09-26 侦察地图，文件/行号已核verified）

- **注册表**（ticket 12，DONE）：`src/main/registry.ts` — `RegistryRecord {id, title, cwd, createdAt, updatedAt, runState, piSessionFile?, archived?, renamedAt?}`；`registryPath()` = userData/sessions.json；`defaultTitle(cwd, title)`（MAX_TITLE 80）；`preserveCorrupt` 备份。分叉 = 新 RegistryRecord + 派生标题 + 建议加 `derivedFrom?: {sessionId, messageId}` 可选字段（PersistShape version 1 加性）。
- **PI 会话文件采用**：`SessionManager.open(path, sessionDir?, cwdOverride?)`（session-manager.d.ts:369）——worker `setSessionCwd` 已用（worker.ts 2235-2241）。分叉实现：复制父 `piSessionFile`（JSONL SessionEntry）→ 截断分叉点之后的条目 → `SessionManager.open(copiedFile, undefined, cwd)`。
- **会话创建**：worker `case 'createSession'`（~2137-2152）→ `attachSession(sessionId, cwd, sessionManager)`（2127 setupPermissionGate）；配置继承 = 创建后对 host.session `setModel`/`setThinkingLevel`（2418 handler 模式，persist: false）。
- **消息 id 映射**：worker `message_end` emit（1770-1777：`{type, ...meta, message: chat}`）——查 meta 里的 entry id；renderer useChat ChatItem id 从事件来。分叉点 = 稳定完成的 assistant 消息的 entry id。
- **渲染端**：`ChatView.tsx` — ChatItem（useChat）；CopyButton memo 模式（75 行+，icons from './icons'）；分叉入口只放稳定完成的 assistant 行；调用 codexApi 新方法 → IPC → main → worker。
- **IPC 链模式**：`permissionRulesIpc.ts`（ipcGuard + ipcMain.handle，从 index.ts 注册）→ preload invoke 面（161-181）→ src/renderer/src/api。
- **队列/后台任务**：worker/App 按会话持有——新会话天然没有；验证无复制即可。
- **测试模式**：tests/*.test.ts（vitest）；分叉的纯逻辑（历史前缀截断 + 注册表记录）可无 app 测试（registry.ts 模式 + JSONL 解析）。

- [x] 稳定完成的助手消息上出现分叉入口；不稳定消息/用户消息/工具结果无入口
- [x] 分叉产生的新会话：历史截至分叉点、配置继承、标题与派生标记正确
- [x] 原会话不受影响，可继续正常运行
- [x] 分叉不回滚磁盘文件的语义在 UI 或提示中可见
- [x] 队列/后台任务不复制到新会话
- [x] 与注册表持久化兼容：重启后分叉会话仍在（继承工单 12 的持久层）
