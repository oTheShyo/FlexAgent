# FlexAgent 缺口审查报告

**审查时间：** 2026-09-24 晚
**审查范围：** `src/renderer/**`（前端轨）+ `src/main/**`、`src/preload/**`、`src/shared/**`（后端轨，含未提交在制品）+ `docs/*.md` 对账
**基线：** `e79a01b`（logo 提交后），工作区含未提交的后端 MCP 批次
**方法：** 契约（`src/shared/contract/index.ts`）↔ 主进程注册（`src/main/ipc.ts`）↔ preload 桥 ↔ 渲染层消费 四方交叉核对，逐条给文件行号

> **后续状态（同日）：**
> - 第一批 A1 / A2 / A4 / C1 已处理并提交（`22d42a2`），条目内标 ✅。
> - 第二批把渲染层能修的全部修完：A3 / A5 / A6 / B2 / B4 / C2 / C3，逐条见下方标 ✅。
> - 仍开放的是**必须后端配合**的条目（B3 / B5 / B6 / B7–B10）——前端轨**不伪造**这类控件，理由见文末「后端门控项」。

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

### A3. 拖拽"附件"只是拼字符串 ✅ 已改为真实暂存 + 校验 + 内容内联

- 原状：`Composer.tsx` `handleDrop` 只把 `@${file.name}` 拼进 textarea——不读内容、不校验、不带路径。
- 现状：新增 `components/composerAttachments.ts`（类型/大小/数量三重校验 + 文本读取），drop 与 paste 都走它；被拒文件在输入框上方给出**可见原因**（`empty file` / `only text files can be attached` / `images cannot be attached yet` / `too large (…, limit 64.0 KB)`）。
- 契约仍无附件字段（`PromptInput = { sessionId, text, mode }`），既没有上传通道、也没有内核自行读取的路径。因此提交时把文本内容以 `--- name --- … --- end name ---` 分隔块**内联进消息**——这是唯一在 mock 与真链路上都不造假的做法；chip 与文本都不再写入草稿（`drop no longer pastes a filename into the draft` 已由走查断言）。
- 上限：单文件 64 KB / 单条消息 192 KB / 5 个文件。

### A4. slash 命令补全：后端已交付，前端零消费 ✅ 已实现

- 全 `src/renderer/` 搜索 `listSlashCommands` / `SlashCommandSummary` → **0 命中**（本轮之前）
- 后端已就绪且已提交（`379097b Add listSlashCommands IPC for composer completion`）：
  - `src/shared/contract/index.ts:327` `SlashCommandSummary`、`:606` `listSlashCommands?(): Promise<SlashCommandSummary[]>`
  - `src/main/ipc.ts:324` `ipcMain.handle(IPC.listSlashCommands, ...)`
  - `src/preload/index.ts:166` 桥已暴露
- 现状：`useChat` 消费可选桥方法并订阅 `subscribePlugins` 自动刷新；`Composer` 的补全面板泛化为 `CompletionPopup`，命令与文件提及共用键控与 a11y 关联。

### A5. 删除会话有完整后端，无 UI 入口 ✅ 已接入口

- 后端 `deleteSession` 是**真实现**（`src/main/ipc.ts:151` → kernel `disposeSession` + `terminals.disposeSession` + `registry.remove`），前端一直没调用。
- 现状：会话行菜单新增 `Delete…` → 二次确认（面板内联提示 + `Cancel` / `Delete`，初始焦点落在 `Cancel`）→ `useChat.deleteSession` 调 API、刷新列表；若删的是当前会话则先退订、清态，再打开剩余列表中最新的一个。
- 删除同时清理本地覆盖层（`clearSessionMeta`），避免 id 复用后被旧标题污染。

### A6. Rename / Archive 是 localStorage 假持久化 🔶 收窄到"诚实的临时方案"

- 后端 `renameSession`/`archiveSession` 仍不做（`backend-handoff.md:210` 明确），所以覆盖层本身保留；本次修掉的是它**会撒谎**的部分：
  - 删会话时清理对应覆盖项（原来会留下来，等 id 复用后凭空改标题）；
  - 每次成功 `listSessions` 后 `pruneSessionMeta` 丢弃已不存在会话的覆盖项（换设备删除、内核侧删除都能收敛）；
  - 归档数量显示在开关上（`Archived · N`），归档状态不再是"点了没反馈"；
  - Settings 面板明示"主题 / 重命名 / 归档仅存本机"。
- 仍未解决的本质：跨设备不共享。等后端提供 rename/archive 后，覆盖层可被 `listSessions` 结果直接覆盖掉。

---

## B. 计划内未做（有据可查，非 bug）

| # | 缺口 | 证据 |
|---|---|---|
| B1 | Scheduled 入口 disabled | `Sidebar.tsx:235` `disabled title="Coming soon"` |
| B2 | 无 Projects 概念 | ✅ 已做 Projects-lite：侧栏可折叠 Projects 分区，按 `SessionSummary.cwd` 聚合（真实的 `cwd`，非新概念）；选中即过滤聊天列表，主按钮随之变为 `New chat in <项目>` 并在该目录建会话，`+` 走原生目录选择器 |
| B3 | 无 Plan / Ask 模式 | `PromptMode` 仅 `steer \| followUp`（`contract/index.ts:143`）；文档 `backend-handoff.md:301` 标"本轮不做" · **后端门控** |
| B4 | Settings 只有主题一项 | ✅ 已扩：Shortcuts（直接读 `lib/shortcuts.ts` 真值表）+ Environment（真实桥接类型 Electron/mock、平台、会话数、当前项目目录），并明示本地持久化范围。API key / 默认模型 / 默认审批仍缺 · **后端门控** |
| B5 | userConfig 只读，不能保存 | `plugin-frontend.md:201` 明确 P1 只读、P2 才做保存 · **后端门控**（契约无 `saveUserConfig` 类命令） |
| B6 | MCP 无可视配置 UI | MCP 组件在详情面板能显示（`PluginDetailPanel.tsx:15` `KIND_ORDER` 含 `mcp`），但 env/args 只能写死在 manifest，UI 无法填（如需 API key 的 MCP server 不可用）· **后端门控**（同上，缺写入通道） |
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

### C2. `respond` 用 state 而非 ref 取 sessionId ✅ 已修

- 原状：`respond` 依赖 `activeSessionId`（state），而其余所有 API 调用统一用 `activeIdRef.current`（ref）。快速切会话时存在把权限应答发给旧会话的窗口。
- 现状：取 sessionId 改走 `activeIdRef.current`，与 `send` / `stop` / `applyFiles` 一致；`toolCallId` 仍来自 `pendingPermission`（它在切会话时已被 `openSession` 清空，无需再防）。

### C3. xterm 主题不跟随主题切换 ✅ 已修

- 原状：`TerminalDrawer.tsx` 注释自己承认：主题在 mount 时解析一次，切换 light/dark 需关掉抽屉重开才生效。
- 现状：`lib/theme.ts` 新增 `subscribeThemeChange`（`writeTheme` 通知 + `prefers-color-scheme` 监听，后者覆盖 `preference = system` 时 OS 切换的场景）；抽屉订阅后把 `readTerminalTheme()`（每次读取实时 CSS 变量）重新赋给 `term.options.theme`，抽屉保持挂载即可换色。

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

## E. 交付顺序（本轮已全部执行）

| 批次 | 内容 | 状态 |
|---|---|---|
| 1 | slash 补全（A4）· 审批 chip 收敛（A1）· 错误降级（C1）· @-mention 路径（A2） | ✅ `22d42a2` |
| 2 | 附件暂存（A3）· 删除入口（A5）· 覆盖层诚实化（A6）· Projects（B2）· Settings（B4）· `respond` 取值（C2）· 终端配色（C3） | ✅ 见 `plugin-frontend.md` §9.6.4 |
| — | 后端 MCP 批次提交（D） | ⏳ 工作区在制品，跨轨未动 |

---

## F. 后端门控项：前端轨**故意不实现**

这几项都属于"控件能做出来，但一点就没反应"的类型，与 A1 是同一个陷阱，因此渲染层**不伪造**，等契约只增后再做：

| # | 缺的前提 | 若硬做的后果 |
|---|---|---|
| B3 Plan/Ask | `PromptMode` 扩枚举 + 内核语义（PI 侧行为） | 与 A1 原状相同：切了档位，行为不变 |
| B5 userConfig 保存 | 契约无写命令，主进程无落盘实现 | 表单能填、保存无效，比只读更误导 |
| B6 MCP 配置 UI | 同上（`env`/`args` 需写回 manifest） | 需要 API key 的 MCP server 仍不可用 |
| B7 非 stdio MCP | `pluginMcp.ts` 仅支持 `stdio` | 填了 http/sse 也连不上 |
| B8 hook veto · B9 npx 源 · B10 `UserPromptSubmit` 对等 | 内核/移植层产品决策（`plugin-porting.md` 已明确不做） | 纯产品范围问题，UI 无对应动作 |

---

## G. 顺带发现

- ✅ **`.workbuddy/` 已加入 `.gitignore`**（连同 `robot_gardener_story.md/.txt`、`scripts/diag-model-*.mjs`——handoff 已标注"永不入库"，现在即使误用 `git add -A` 也带不进去）。
- 原有杂物仍在工作区（未删除，也不入库）：`robot_gardener_story.md/.txt`、`scripts/diag-model-fix.mjs`、`scripts/diag-model-ui.mjs`。
