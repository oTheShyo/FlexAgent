# FlexAgent 缺口审查报告

**审查时间：** 2026-09-24 晚
**审查范围：** `src/renderer/**`（前端轨）+ `src/main/**`、`src/preload/**`、`src/shared/**`（后端轨，含未提交在制品）+ `docs/*.md` 对账
**基线：** `e79a01b`（logo 提交后），工作区含未提交的后端 MCP 批次
**方法：** 契约（`src/shared/contract/index.ts`）↔ 主进程注册（`src/main/ipc.ts`）↔ preload 桥 ↔ 渲染层消费 四方交叉核对，逐条给文件行号

> **后续状态（同日）：** A1 / A2 / A4 / C1 已处理并提交（`22d42a2`），条目内标 ✅。其余条目仍开放。

---

## A. 阻断级：契约/UI 摆在那儿，但链路没接上

### A1. 审批模式选择器是纯装饰，点了没有任何效果 ✅ 已收敛（disabled + tooltip）

- `Composer.tsx:27` `const APPROVAL_MODES = ['Manual', 'Auto', 'Full access'] as const`
- `Composer.tsx:101` `const [approvalIndex, setApprovalIndex] = useState(0)`
- `Composer.tsx:314-316` `cycleApproval()` 只做 `setApprovalIndex((prev) => (prev + 1) % 3)`
- `Composer.tsx:210-217` `submit()` 传给 `onSend` 的只有 `text` 和 `mode`（steer/followUp），**approval 从不外传**

契约侧印证：`PromptInput` 没有 approval/autoApprove 字段；权限是逐次 `permission_request` + `respondPermission`。
`docs/backend-handoff.md:301` 记录「Plan/Ask 模式本轮不做」——但三档审批 chip 已经在 UI 上可点，用户会以为切到 Full access 就放行了。**要么接后端，要么 disabled + tooltip。**

### A2. @-mention 文件列表是硬编码假数据，且一半路径在仓库里不存在 ✅ 已修复

- `composerFiles.ts:1-6` 自述：`Mock file list ... intentionally NOT backed by CodexApi / IPC (listFiles is deferred per backend handoff §7.1#2)`
- `composerFiles.ts:7-32` 24 条写死路径，其中：
  - `src/renderer/tailwind.config.js` → 实际在仓库根 `tailwind.config.js`
  - `src/renderer/src/styles.css` → 实际是 `src/renderer/src/index.css`
  - `src/shared/contract.ts` → 实际是 `src/shared/contract/index.ts`
  - 且完全没有 `pluginIcons.tsx`、`usePlugins.ts`、`MarketplacePanel.tsx` 等本轮新增文件

后端 `listFiles` 明确 deferred 可以接受，**但 fixture 内容是错的**——用户敲 `@comp` 补出来的路径粘进 prompt 是无效路径。

### A3. 拖拽"附件"只是拼字符串

- `Composer.tsx:292-312` `handleDrop`：`const snippet = files.map((file) => `@${file.name} `).join('')`，直接拼进 textarea
- 不读文件内容、不上传、不校验存在性、不带目录路径

契约也无附件字段（`docs/backend-handoff.md:301` 提到 v1.3 可只增 `attachments`，尚未做）。当前能力 = 帮你打一串文件名。

### A4. slash 命令补全：后端已交付，前端零消费 ✅ 已实现

- 全 `src/renderer/` 搜索 `listSlashCommands` / `SlashCommandSummary` → **0 命中**
- 后端已就绪且已提交（`379097b Add listSlashCommands IPC for composer completion`）：
  - `src/shared/contract/index.ts:327` `SlashCommandSummary`、`:606` `listSlashCommands?(): Promise<SlashCommandSummary[]>`
  - `src/main/ipc.ts:324` `ipcMain.handle(IPC.listSlashCommands, ...)`
  - `src/preload/index.ts:166` 桥已暴露
- `Composer.tsx:29` 只有 `const MENTION_BEFORE_CARET = /@[\w./-]*$/`，没有任何 `/` 检测

对应 `docs/plugin-frontend.md` §9.6.1「现在就排」，是当前前端队列里唯一已解阻的实活。

### A5. 删除会话有完整后端，无 UI 入口

- 契约 `CodexApi.deleteSession`（`contract/index.ts:537`）、IPC `codex:deleteSession`（`:616`）、`src/main/ipc.ts` 已注册
- `MockCodexApi.deleteSession`（`api/mock.ts:196`）也实现了
- `grep deleteSession src/renderer/` 只命中 mock 自身 → **UI 从未调用**
- `Sidebar.tsx:349-361` 会话右键菜单只有 `Rename` / `Archive`

### A6. Rename / Archive 是 localStorage 假持久化

- `lib/sessionMeta.ts:20` `const STORAGE_KEY = 'codex.sessionMeta.v1'`，`:45`/`:53` 读写 `window.localStorage`
- 后果：改的标题、归档状态只存本机；换设备、清缓存即丢；也与后端 `listSessions` 返回的 title 永久不一致
- 这是 `docs/backend-handoff.md:210` 明确认可的临时方案（后端 `renameSession`/`archiveSession` 不做），但**用户视角的"归档"其实什么都没归档**

---

## B. 计划内未做（有据可查，非 bug）

| # | 缺口 | 证据 |
|---|---|---|
| B1 | Scheduled 入口 disabled | `Sidebar.tsx:235` `disabled title="Coming soon"` |
| B2 | 无 Projects 概念 | 产品定义是「左侧 Projects/会话栏」，现侧栏只有扁平 chats + search；`pickDirectoryOrNewSession` 能选目录，但目录不成为可复用实体 |
| B3 | 无 Plan / Ask 模式 | `PromptMode` 仅 `steer \| followUp`（`contract/index.ts:143`）；文档 `backend-handoff.md:301` 标"本轮不做" |
| B4 | Settings 只有主题一项 | `CommandPalette.tsx:230-287`，`data-testid="settings-panel"` 内仅 Appearance/Theme 三档；无 API key/provider、默认模型、默认审批、快捷键表 |
| B5 | userConfig 只读，不能保存 | `plugin-frontend.md:201` 明确 P1 只读、P2 才做保存 |
| B6 | MCP 无可视配置 UI | MCP 组件在详情面板能显示（`PluginDetailPanel.tsx:15` `KIND_ORDER` 含 `mcp`），但 env/args 只能写死在 manifest，UI 无法填（如需 API key 的 MCP server 不可用） |
| B7 | 非 stdio MCP 不支持 | `pluginMcp.ts:8` `SUPPORTED_MCP_TYPES = new Set(['stdio'])`，http/sse 记 `plugin_unsupported_mcp` warning |
| B8 | hook 无 veto 能力 | `plugin-porting.md:170` P2c 不做 veto，exit 2 仅记 `hook_block_ignored` |
| B9 | marketplace `npx` 源类型未实现 | `plugin-porting.md:30` 标 SKIP，抛 Unsupported |
| B10 | `UserPromptSubmit` 无 PI 对等 | `plugin-porting.md:88`，仅记 diagnostic 不阻断 |

---

## C. 毛刺 / 半成品

### C1. 任何错误都会误报"连接丢失"，且 banner 卡住不自动恢复 ✅ 已修复

- `useChat.ts:351-362`：`case 'error'` 里 **无条件** `applyDegraded()` → `setConnectionMessage('Connection lost — reconciling…')`
- 但只有 `code === 'KERNEL_INTERNAL'` 才触发 `reconcileRef.current?.()`
- `applyReconnected()` 只在 `openSession` 成功时调用（`useChat.ts:388`）
- 错误码全集只有 14 个（`contract/index.ts:58-112`，无 MODEL_ERROR 类），其中 `SESSION_BUSY` / `INVALID_INPUT` / `PERMISSION_EXPIRED` 都是**正常业务错误**——例如 run 进行中点 Diff Accept 就会拿到 `SESSION_BUSY`，然后 UI 挂上"连接丢失"且不自动消失
- 建议：只在 `KERNEL_INTERNAL` 时降级；其余错误只 push 错误块

### C2. `respond` 用 state 而非 ref 取 sessionId

- `useChat.ts:536-549` `respond` 依赖 `activeSessionId`（state），而其余所有 API 调用统一用 `activeIdRef.current`（ref）。快速切会话时存在把权限应答发给旧会话的窗口。

### C3. xterm 主题不跟随主题切换

- `TerminalDrawer.tsx:86-89` 注释自己承认：主题在 mount 时解析一次，切换 light/dark 需关掉抽屉重开才生效

---

## D. 后端在制品状态（未提交，MCP 批次）

**未跟踪新文件：**
- `src/main/mcp/mcpClient.ts`（7.8 KB）
- `src/main/pluginMcp.ts`（238 行）

**已修改未提交：** `pluginBridge.ts`、`pluginManifest.ts`、`pluginRegistry.ts`、`worker.ts`、`kernel-protocol.ts`、`package.json`/`lock`、`THIRD_PARTY_NOTICES.md`、`docs/plugin-{backend,porting,frontend}.md`、`scripts/accept-plugins.mjs`

**链路核实（是通的，不是半成品）：**
1. `pluginManifest.ts:191` 校验 `mcpServers` 声明，`:523` 枚举 `mcp` 组件（含 `.mcp.json`）
2. `pluginRegistry.ts:199` 调 `collectMcpServerConfigs` → `:214` `Object.assign(spec.mcpServers, mcpResult.configs)`
3. `worker.ts:128-150` `startMcpToolBridge()` → `connectMcpClient` → `listMcpTools` → 暴露为 PI 工具（`McpToolBridgeDef`），带 `inflightMcpCalls` 跟踪与 `:166-169` 清理
4. 安全面有做：`resolveInside` 防路径逃逸（`pluginMcp.ts:38-43`）、sensitive key 不插值进 command（`:163-164`）、`FLEX_PLUGIN_ID` 注入 env

**验证：** `npm run typecheck` + `npm run build` **双绿**（含这批在制品）。

**判断：** 后端 MCP 主体完成度高，缺的是「提交」和「前端配置 UI」（B6）。IPC 常量与注册无缺口（未在 `ipc.ts` 出现的 7 个常量全是 `send` 型事件通道或 `registerMarketplaceIpc` 内的 MCP/市场通道）。

---

## E. 建议优先级

1. **slash 补全**（A4）—— 后端已交付、前端零依赖，队列里唯一解阻项，直接可做
2. **审批模式二选一**（A1）—— 要么接 `permission` 链路，要么 disabled + tooltip；留着是误导
3. **错误降级收敛**（C1）—— 3 行改动，消掉"用一次 Accept 就显示连接丢失"
4. **@-mention fixture 修正**（A2）—— 至少把路径改对，或直接换成 `cwd` 相对路径的占位说明
5. **后端 MCP 批次提交**（D）—— 别让 8 个文件 + 2 个新模块长期躺在工作区

---

## F. 顺带发现

- **`.workbuddy/` 未跟踪且未 ignore**（`git status` 显 `?? .workbuddy/`）——里面是本次会话的工作记忆，属项目本地数据，建议加进 `.gitignore`，避免哪天被 `git add -A` 带进去。
- 原有杂物仍在工作区：`robot_gardener_story.md/.txt`、`scripts/diag-model-fix.mjs`、`scripts/diag-model-ui.mjs`（handoff 标注"永不入库"）。
