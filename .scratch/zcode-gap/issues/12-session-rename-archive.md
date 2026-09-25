# 12: 会话重命名/归档后端

**What to build:** 会话的重命名与归档落到真实持久层（会话注册表 sessions.json），替换当前的 localStorage 遮罩（gap-audit A6 遗留）。重命名/归档后跨窗口、跨重启保持；列表接口返回这些字段；既有删除语义与备份策略不回归。侧栏的置顶/分组等任务管理体验以此为基础（更多分组能力留给后续工单）。

**Blocked by:** 01 (落库未提交子系统)

**Status:** done

- [x] 重命名持久化：重启应用/新窗口后名称保持
- [x] 归档持久化：归档会话从主列表消失、可在归档视图恢复
- [x] localStorage 遮罩代码移除，UI 只读真实字段
- [x] 会话列表接口返回 title/archived 字段，兼容旧 sessions.json（缺字段时平滑默认）
- [x] 注册表写入仍保留现有的损坏备份策略
- [x] 删除会话路径回归：delete 后重命名/归档状态一并清理，无悬挂数据

## 交付记录

- `registry.ts`：`RegistryRecord` 增 `archived`/`renamedAt`；新增 `setTitle`（拒绝空标题、截 80 字）与 `setArchived`；`load()` 对旧 sessions.json 兜底（缺字段=未归档、标题回退 cwd 派生名）；`toSummary` 输出 `archived`。
- 契约只增：`SessionSummary.archived?`、`RenameSessionInput`、`SetSessionArchivedInput`、API + IPC `codex:renameSession` / `codex:setSessionArchived`。
- **删除** `src/renderer/src/lib/sessionMeta.ts`（localStorage 遮罩）及 App / CommandPalette / Sidebar 的全部引用；Sidebar 改读 `session.title` / `session.archived`。
- 写入后在 `useChat` 里 refreshSessions 再渲染：失败就保持旧标题，不做乐观更新。
- delete 路径无悬挂数据（状态随注册记录一并删除，旧的 prune 逻辑随之删除）；损坏备份策略未改。
- 未做真机验证（Electron 本机未起），typecheck + build 绿。
