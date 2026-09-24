# 插件系统 · 前端实现计划（前端轨）

**读者：你是前端轨会话。按本文干活即可。**
**上游设计：** [`docs/plugin-design.md`](./plugin-design.md)（先读 §1/§3/§4 了解全貌）
**后端契约落地面：** [`docs/plugin-backend.md`](./plugin-backend.md) §1（契约类型/方法/IPC）——你消费的就是这些
**改动边界：** **只改 `src/renderer/**`**。`src/shared/contract/index.ts` 的类型由后端轨落地；你若先开工，按本文 §2 的签名**假定已在**（或本地临时补，联调时以后端为准）。**不要**改 `src/main/**`、`src/preload/**`。

> **背景一句话：** 侧栏 `Plugins` 按钮（`Sidebar.tsx` L264）是死按钮。P1 要把它接成一个插件管理页：**列表 + 详情 + 安装(本地目录) + 启停 + 卸载**。数据来自 `codexApi`（真链路走 IPC；无 Electron 时走 `MockCodexApi`）。

---

## 0. 现状（先看，别重复造）

| 项 | 位置 | 说明 |
|----|------|------|
| 死按钮 | `src/renderer/src/components/Sidebar.tsx` L31-40 `PluginsIcon`、L264 `<NavRow icon={<PluginsIcon />} label="Plugins" />` | 无 `onClick`。`NavRow` 已支持 `onClick`。 |
| 视图切换 | `src/renderer/src/App.tsx` L25-27 | **无路由**，用布尔态：`showTerminal`/`showReview`/`showPalette`。照此加 `showPlugins`。 |
| API 入口 | `src/renderer/src/api/index.ts` | `window.electron?.codex ? window.electron.codex : new MockCodexApi()` |
| 类型 re-export | `src/renderer/src/types/index.ts` | `export * from '../../../shared/contract'` —— 插件类型加进 contract 后，这里自动可见 |
| Mock | `src/renderer/src/api/mock.ts` | `MockCodexApi implements CodexApi`。**必须**同步实现新方法，否则 `typecheck` 红 |
| 空态样式 | `src/renderer/src/components/EmptyState.tsx` | 复用其视觉（图标 + 标题 + 副文案） |
| 命令面板 | `src/renderer/src/components/CommandPalette.tsx` | 加一条 "Manage plugins" 动作 |
| Hook 范例 | `src/renderer/src/hooks/useChat.ts` | 渲染层如何消费 `codexApi` 命令 + `subscribe` 事件——照抄模式 |

---

## 1. 你的交付物（P1）

1. **Mock 补齐**：`MockCodexApi` 实现 5 个插件方法 + `subscribePlugins`，带 fixture，能独立演示全部 UI 状态。
2. **插件 Hook**：`src/renderer/src/hooks/usePlugins.ts`——加载列表、订阅变更、启停/安装/卸载、详情加载。
3. **插件页**：`src/renderer/src/components/PluginsPage.tsx`（列表 + 空态 + 安装按钮 + 加载骨架）。
4. **详情面板**：`src/renderer/src/components/PluginDetailPanel.tsx`（组件清单 + 元信息 + 卸载）。
5. **接线**：`Sidebar.tsx` 补 `onClick` + `active`；`App.tsx` 加 `showPlugins` 态并渲染插件页；`CommandPalette.tsx` 加动作。
6. **typecheck 双绿** + mock 下可完整走查（见 §6）。

---

## 2. 契约接口（你要消费的）

> 后端在 `src/shared/contract/index.ts` 落地。与你相关的部分：

```ts
type PluginId = string
type PluginComponentKind = 'extension' | 'skill' | 'command' | 'hook' | 'mcp'

interface PluginSummary {
  id: PluginId; name: string; version: string; description?: string
  enabled: boolean
  source: { kind: 'bundled' | 'local' | 'marketplace'; label: string }
  componentCounts: Partial<Record<PluginComponentKind, number>>
}

interface PluginComponentInfo { kind: PluginComponentKind; name: string; description?: string; path?: string }

interface PluginUserConfigSpec {
  key: string; title: string; description?: string
  type: 'string' | 'number' | 'boolean' | 'directory' | 'file'
  default?: string | number | boolean; required?: boolean; sensitive?: boolean
}

interface PluginDiagnostic { code: string; severity: 'error' | 'warning'; message: string; pluginId?: PluginId }

interface PluginDetail extends PluginSummary {
  author?: string | { name: string; email?: string; url?: string }
  homepage?: string; keywords?: string[]; rootPath: string
  components: PluginComponentInfo[]
  userConfig?: PluginUserConfigSpec[]
  configuredOptions?: Record<string, string | number | boolean>
  diagnostics?: PluginDiagnostic[]
}

interface InstallPluginInput { source: { kind: 'directory'; path: string } }

interface PluginChangeEvent { plugins: PluginSummary[] }
```

**新增 `CodexApi` 方法：**

```ts
listPlugins(): Promise<PluginSummary[]>
getPlugin(id: PluginId): Promise<PluginDetail>
setPluginEnabled(id: PluginId, enabled: boolean): Promise<PluginSummary>
installPlugin(input: InstallPluginInput): Promise<PluginSummary>
uninstallPlugin(id: PluginId): Promise<void>
subscribePlugins(listener: (event: PluginChangeEvent) => void): () => void
```

**新增错误码**（reject 的 `ContractError.code` 可能是）：`PLUGIN_NOT_FOUND`、`PLUGIN_ALREADY_INSTALLED`、`PLUGIN_MANIFEST_INVALID`、`PLUGIN_COMPONENT_INVALID`、`PLUGIN_PATH_INVALID`。

**安装来源（P1 关键）：** `installPlugin` 只接受**本地目录路径**。UI 需要让用户选目录——**复用已有的 `pickDirectory()`**（契约 v1.3 已有，返回 `string | null`）：

```ts
const dir = await codexApi.pickDirectory()
if (dir === null) return              // 用户取消
await codexApi.installPlugin({ source: { kind: 'directory', path: dir } })
```

> 详情里的「选择目录」也可用 `userConfig` 里 `type: 'directory'` 的项——但 P1 不做配置表单（见 §5），只做安装选目录。

---

## 3. Mock 实现要求（`src/renderer/src/api/mock.ts`）

`MockCodexApi` 必须实现 5 方法 + `subscribePlugins`，**行为与真链路一致**，使 `typecheck` 双绿且 UI 可离线走查。

**fixture 建议：**
- 预置 2 个插件：一个 `enabled: true` 的 `document-skills@bundled`（`componentCounts: { skill: 2 }`），一个 `enabled: false` 的 `local-demo@local`（`componentCounts: { extension: 1, skill: 1 }`）。
- `getPlugin` 返回对应 `components` 数组（含 `name`/`description`）+ `userConfig` 示例（含一个 `sensitive: true` 项，用于验证打码）。

**行为规则（照真链路语义）：**
- `setPluginEnabled`：**幂等**——状态未变也算成功，返回当前 `PluginSummary`；状态变则更新并（用 `window.setTimeout` 异步）触发 `subscribePlugins` 推送新列表。
- `installPlugin`：
  - 校验非空 path，否则 reject `ContractError('INVALID_INPUT', ...)`；
  - 若 fixture 或已装集合里已有同 name → reject `ContractError('PLUGIN_ALREADY_INSTALLED', ...)`；
  - 成功：加入列表（`enabled: true`, `source.kind: 'local'`），推 `pluginsChanged`。
- `uninstallPlugin`：不存在 → reject `ContractError('PLUGIN_NOT_FOUND', ...)`；成功 → 移除 + 推送。
- `getPlugin`：不存在 → reject `PLUGIN_NOT_FOUND`。
- `subscribePlugins`：与 mock 现有 `subscribe` 同款——`Set<listener>` + 返回退订闭包；**全局共享一个 handler 集合**（非 session-scoped）。
- 错误一律 `new ContractError(code, message)`（mock 已 import `ContractError`）。

**注意：** mock 的延迟用固定区间（沿用现有 `window.setTimeout` 模式），无网络。

---

## 4. `usePlugins` hook 规格（`src/renderer/src/hooks/usePlugins.ts`）

仿 `useChat.ts` 的结构（命令 + 订阅 + 错误态）。建议导出：

```ts
interface UsePluginsResult {
  plugins: PluginSummary[]
  loading: boolean                       // 首次加载中
  loadingDetail: boolean
  detail: PluginDetail | null            // 当前打开的详情
  error: string | null                   // 最近一次命令失败的 human message
  installFromDirectory: () => Promise<void>   // pickDirectory → installPlugin
  toggleEnabled: (id: PluginId, enabled: boolean) => Promise<void>
  openDetail: (id: PluginId) => Promise<void>
  closeDetail: () => void
  uninstall: (id: PluginId) => Promise<void>
}
```

要点：
- 挂载时 `listPlugins()` → `setPlugins`；`subscribePlugins` 收到 `PluginChangeEvent` → `setPlugins(event.plugins)`（**以推送为准**，无需本地合并）。
- 每次命令 `try/catch`：`catch` 里把 `(err as { message?: string }).message` 落到 `error`（真链路 reject 是 `{code,message,details}` plain object）。
- `toggleEnabled` / `uninstall` 后**不用**手动刷新——等 `pluginsChanged` 推送（真链路会推；mock 也推）。若担心推送延迟，可乐观更新再由推送对账（二选一，保持与 `useChat` 一致的风格）。
- 卸载成功后若 `detail?.id === id` → `closeDetail()`。
- **注意启停会触发内核重启**：真链路下启停后会话会被刷新。UI 在 `toggleEnabled` 期间显示"重新加载中…"（可用一个 `busyId` 状态），完成后由 `pluginsChanged` 收尾。

---

## 5. UI 规格

### 5.1 接线（必做）

**`Sidebar.tsx`：**
- Props 加 `onOpenPlugins?: () => void` 与 `pluginsActive?: boolean`。
- L264 改为：`<NavRow icon={<PluginsIcon />} label="Plugins" active={pluginsActive} onClick={onOpenPlugins} />`。
- （`Scheduled` 保持死按钮不动。）

**`App.tsx`：**
- 加 `const [showPlugins, setShowPlugins] = useState(false)`。
- 加 `usePlugins()`；把 `handleOpenPlugins = () => setShowPlugins(true)`、`handleClosePlugins = () => setShowPlugins(false)`。
- 主内容区（L276-278 的 `<div className="min-h-0 flex-1 overflow-y-auto">`）内：`showPlugins ? <PluginsPage .../> : content`。
  - **推荐**：`showPlugins` 为真时整块替换为新聊天/会话区（与现有"视图切换"一致）。
- `handleEscape`（L173）加：先关插件页（`if (showPlugins) { closeDetail… 或 setShowPlugins(false) }`）——注意详情面板打开时应先关详情。
- `Sidebar` 传 `pluginsActive={showPlugins}`、`onOpenPlugins={handleOpenPlugins}`。
- `CommandPalette` 传 `onOpenPlugins={handleOpenPlugins}`。

**`CommandPalette.tsx`：**
- Props 加 `onOpenPlugins: () => void`。
- `commands` 里加一条：`{ id: 'plugins', label: 'Manage plugins', hint: 'Action', run: () => { onOpenPlugins(); onClose() } }`。
- 图标可复用 4 方块图标（自己加一个 `PluginsIcon` 小图标，样式对齐现有 `h-4 w-4`）。

### 5.2 `PluginsPage.tsx`

结构（沿用现有 Tailwind + CSS 变量视觉）：

- **页头**：标题 `Plugins` + 右侧主按钮 **`Install from folder`**（→ `installFromDirectory`）。
- **错误条**：`error !== null` 时显示一条可关闭的提示（对齐 `ConnectionBanner` 的视觉）。
- **加载态**：`loading` → 用 `Skeleton`（见 `Skeleton.tsx` 的 `SessionListSkeleton` 模式）自建列表骨架。
- **空态**：无插件 → 复用 `EmptyState` 视觉，文案：
  - 标题：`No plugins yet`
  - 副文案：`Install a plugin from a folder to extend FlexAgent.`
- **列表**：每行一个插件卡片/行：
  - 图标 + `name` + `version`（弱化）+ `source.label` 徽标（如 `Local`/`Bundled`）。
  - **组件计数徽标**：由 `componentCounts` 生成，如 `2 skills · 1 extension`（kind → 中文/英文标签映射：`extension`→`extension(s)`、`skill`→`skill(s)`、`command`→`command(s)`、`hook`→`hook(s)`、`mcp`→`MCP`）。
  - **启用开关**：一个 switch（`role="switch"` + `aria-checked`）。切换 → `toggleEnabled(id, next)`；`busyId === id` 时禁用并显示 `Reloading…`。
  - 点击行主体 → `openDetail(id)`。
- **data-testid**（供后续验收脚本）：容器 `data-testid="plugins-page"`、安装按钮 `data-testid="plugins-install"`、行 `data-testid={`plugin-row-${id}`}`、开关 `data-testid={`plugin-toggle-${id}`}`。

### 5.3 `PluginDetailPanel.tsx`

可作为页内右侧/覆盖层（参考 `DiffPanel` 的抽屉/面板处理方式）。

- **头部**：`name` + `version` + 关闭按钮。
- **元信息**：`description`、`author`（字符串或 `{name}`）、`homepage`（外链）、`keywords`。
- **组件清单**（**信任决策的关键**，必须在启用前可见）：按 `kind` 分组列出 `components[]`，每项显示 `name` + `description`。
- **诊断**（若有）：`diagnostics[]`——`severity: 'error'` 红、`'warning'` 琥珀；显示 `code` + `message`。
- **配置**：若 `userConfig` 非空——**P1 只读展示**：列出 `title`、`type`、`default`；`required` 标 `Required`；`sensitive: true` 标 `Sensitive` 并**禁止编辑**（灰显 + tooltip「Sensitive values can't be edited yet」）。**不做**保存（P2）。
- **底部动作**：`Uninstall`（危险按钮，二次确认可选）。卸载 → `uninstall(id)`。
- **data-testid**：`plugin-detail`、`plugin-uninstall`。

---

## 6. 验收（前端自测）

**A. typecheck**：`npm run typecheck` → 双 tsconfig exit 0（含 mock 新方法）。

**B. mock 走查**（`npm run dev`，无 Electron 时自动走 mock；有 Electron 也应能走真链路）：
1. 点侧栏 `Plugins` → 进入插件页；再点仍可（active 高亮）。
2. 列表显示 2 个 fixture；计数徽标正确；开关初始态正确。
3. 点 `Install from folder` → （mock 的 `pickDirectory` 返回固定路径）→ 列表新增一条；重复安装同目录 → 出现 `Already installed` 错误条。
4. 切换任一行开关 → 显示 `Reloading…` → 完成后态更新为 `pluginsChanged` 推送的结果。
5. 点行 → 详情面板：组件按 kind 分组、`sensitive` 项打码禁编、诊断区（给某个 fixture 造一条 warning 验证）。
6. 详情内 `Uninstall` → 行消失、详情关闭。
7. 组件数量与 `componentCounts` 对得上。
8. `Ctrl+K` → 有 `Manage plugins` → 回车进入插件页。
9. `Esc`：详情打开 → 先关详情；再 `Esc` → 关插件页回会话区。

**C. 真链路联调**（后端就绪后）：同样 9 步应行为一致（允许文案/延迟差异）。

> **注：** 若无 Electron / 后端未就绪，你**只需保证 mock 下 A+B 双绿**即可交付；真链路联调由双方后端就绪后共同走。

---

## 7. 明确不做（P1 边界，别越界）

- ❌ 市场 / 浏览商店 / `marketplace.json`（P3）。
- ❌ `userConfig` 表单**保存**（P2；P1 仅只读展示）。
- ❌ commands / hooks / MCP 的运行时交互（P2）。
- ❌ 版本更新检查（P3）。
- ❌ 引入 router（沿用 `App.tsx` 布尔态）。
- ❌ 改 `src/main/**`、`src/preload/**`、`src/shared/contract` 的**语义**（类型由后端落地；你可只读引用）。

---

## 8. 建议实现顺序

1. 确认/补齐 `types` 可见性（contract 新增类型经 `types/index.ts` re-export）。
2. `mock.ts` 补 5 方法 + `subscribePlugins` + fixture → `typecheck` 先绿。
3. `usePlugins.ts`。
4. `PluginsPage.tsx` + `PluginDetailPanel.tsx`（先用 mock 数据调好视觉）。
5. `Sidebar.tsx` / `App.tsx` / `CommandPalette.tsx` 接线。
6. mock 走查 9 步 + `typecheck`。

---

## 9. 当前队列（P2 状态 · 按顺序做）

> 更新时机：P2a/b 已落地（commands 已可用）；P2c hooks 与 P3 marketplace 后端并行开发中。后端轨文件（`src/main/**`、`src/preload/**`、`src/shared/**`）依然碰不得。

### 9.1 现在就做（不等后端）

1. **验证并提交导航修复**（P1 遗留 bug，已修未提交）：
   - 手工验证：进 Plugins 页 → 点侧栏任一会话 → **页面应切回会话区**（此前不切换）；`New chat`/`Projects` 同理；`Esc` 行为不变。
   - 通过后**只提交这一个文件**：`git add src/renderer/src/App.tsx` 然后 commit（风格：英文祈使句首字母大写，如 `Fix plugins view blocking session switch`）。**禁止 `git add -A`/`git add .`**——工作区有后端在制品和杂物（`robot_gardener_story.*`、`scripts/diag-model-*.mjs` 永不入库）。
2. **可选清理**（同文件或前端文件内，随手但各自独立小提交或并入上面提交均可）：
   - `App.tsx` 若存在 `codexApi as PluginApi` 之类冗余类型断言 → 删掉（用真实类型）。
   - `usePlugins.uninstall` 失败路径未清 `busyId` 的话补上（对齐 §4 busy 语义）。

### 9.2 P2b commands 人工 QA（现在可做，真链路）

后端已交付：`.zcode-plugin/.claude-plugin/.codex-plugin/.cursor-plugin` manifest 发现优先级 + `commands/*.md` 枚举 + 内核 `/命令` 注册。你验证 UI 侧：

1. 准备一个本地 fixture 插件目录：manifest（任选一种，如 `.zcode-plugin/plugin.json`）+ `commands/demo.md`（frontmatter `name: demo` / `description: ...` + 正文含 `$ARGUMENTS`）。
2. `Install from folder` 安装 → 打开详情：**组件清单应出现 `kind: command`，name/description 来自 frontmatter**；列表徽标 `componentCounts.command ≥ 1`。
3. 启用插件（`Reloading…` → 内核重启）→ 新会话 → 会话输入框若透传内核 slash commands，`/demo ` 应可补全；输入 `/demo hello` 发送后应出现一条内容为展开正文（`$ARGUMENTS`→`hello`）的用户消息。**若渲染层目前不展示内核命令列表，记录为已知限制即可，不要为此改后端。**
4. 重复安装/坏 manifest 等错误码展示走查（§6.C 里已覆盖的沿用）。

> **已知限制（§9.2 QA 记录；§9.6.2 真链路复核已更新）**：当前渲染层不展示、也不补全内核 slash command 列表——`/demo ` 无自动补全。**发送路径已验证正确**：`/demo hello` 发出后，事件流与 transcript 中的用户消息均为展开正文（`Summarize: hello`），非原文（详见 §9.6.2）。详情面板的 `kind: command` 组件清单与 frontmatter name/description 展示正常。补全 UI 待 `listSlashCommands` IPC 就绪后一并做（§9.6.1 已回复「现在就排」）。

### 9.3 等 P2c（hooks）交付后

- 详情面板组件清单应自动多出 `kind: hook` 分组（§5.3 分组逻辑已覆盖该 kind，无需新 UI）——装一个带 `hooks/` 的 fixture 验证渲染不炸、计数正确。
- 诊断区可能出现新码（如 hook 事件无 PI 对等时的 warning）——确认 `PluginDiagnostic` 渲染能显示未知 code（只展示 code+message，不要硬编码白名单）。

### 9.4 P3 marketplace UI —— 契约已就绪，可以开工

- 后端已交付：`docs/plugin-marketplace.md`（IPC 通道清单 + payload 形状 + QA 步骤）、契约 v1.5（`MarketplaceApi`：`listMarketplaces` / `addMarketplace` / `searchMarketplaces` / `installFromMarketplace` / `subscribeMarketplaceProgress`，挂 `window.electron.marketplace`，与 `CodexApi` 分离）、后端验收 55/55 绿。
- 你的 P3 UI 范围：市场浏览/搜索列表、**Install from URL**、安装进度（`marketplaceProgress` 事件：resolve→download→extract→install→done/error）、错误态（`PLUGIN_SOURCE_INVALID` / `PLUGIN_DOWNLOAD_FAILED`）、与现有 `Install from folder` 并列。
- **先读 `docs/plugin-marketplace.md` 再动手**；Mock 侧按契约补 `MarketplaceApi` 实现（`MockCodexApi` 不用动，新接口独立）。

### 9.5 明确不做 / 不碰

- ❌ `src/main/**`、`src/preload/**`、`src/shared/**`（含 `kernel-protocol.ts`）——双 agent 正在改，碰了必冲突。
- ❌ `THIRD_PARTY_NOTICES.md`、`docs/plugin-porting.md`、`docs/plugin-backend.md`、`scripts/accept-*.mjs`。
- ❌ `userConfig` 表单保存、MCP UI（等后端契约）。
- ❌ 任何 git 写操作超出 9.1 第 1 条的单文件提交。

### 9.6 后端对齐备忘（P2c+P3 交付后 · 后端轨写）

**后端状态（全部验收绿，改动未提交在工作区）：**
- P2a/b/c + P3 全部落地：typecheck 0、accept-plugins **113/113**（含 hook 全套）、accept-marketplace **55/55**、model/fallback/apply 回归绿。
- P2c 交付：`kind: hook` 组件枚举 + `plugin_unsupported_hook` 诊断（如 `UserPromptSubmit` 无 PI 对等）——**§9.3 现在可以做了**。
- P3 交付：契约 v1.5 = **独立 `window.electron.marketplace`（`MarketplaceApi`，不进 `CodexApi`/`MockCodexApi`）**，5 个 IPC 通道 + `marketplaceProgress` 事件，错误码新增 `PLUGIN_SOURCE_INVALID` / `PLUGIN_DOWNLOAD_FAILED`——**§9.4 现在可以做了**。
- 你们提交的 §9.2 限制（渲染层无 slash 补全/展开渲染）已收到，见下面 9.6.1/9.6.2 两个待对齐点。

**9.6.1 Composer slash 命令透传 —— 前端回复：(a) 现在就排**
- 证据：Composer 零 slash 检测、裸文本透传（explore 已确认）；@-mention popup 可复用（先例已在）；前端补全 UI 工作量小，可先空列表（IPC 未就绪时）。
- 请后端加一条**只增**通道 `listSlashCommands`（数据源 = 桥注册的 `*.md` 命令表：name/description），不改现有 IPC。前端随后接补全 popup（照 @-mention 模式）。
- 排序：§9.3 → §9.4 → 本项（补全 UI）。发送路径无需改（内核已拦截 `/cmd` 并展开，见 9.6.2）。
- **后端结论（已确认，排入队列）**：接受 (a)。实现方案已定——新增只增通道 `codex:listSlashCommands`（进 `IPC` 常量与 `IpcChannel` 联合，纯增量），返回 `Array<{ name: string; description?: string; pluginId: string }>`；数据源 = 主进程 `pluginManifest.enumerateComponents` 对**已启用**插件的 `kind: command` 组件枚举（frontmatter name/description，与详情面板同源），**不经过内核、不改现有通道与字段**。前端按约定：IPC 就绪前先空列表，就绪后接 @-mention 式 popup。交付时更新本节状态行。
- **交付状态：已实现（待后端批次提交）。** 契约 `SlashCommandSummary` + `IPC.listSlashCommands` + `CodexApi.listSlashCommands?()`（**可选方法**——你们的 `MockCodexApi` 无需改动即保持 typecheck 绿，消费时用 `codex.listSlashCommands?.()`）+ preload 桥 + `PluginService.slashCommands()`；accept-plugins 追加 3 项 CDP 检查（数组形状 / 含 description+pluginId / 卸载后消失）。你们现在即可在 mock 里补一个 `listSlashCommands` 返回 `[]` 并接补全 popup。
- **前端交付状态（已完成）：** `useChat` 消费 `codexApi.listSlashCommands?.()`，并订阅 `subscribePlugins` 在插件安装/卸载/启停后自动刷新；`Composer` 新增命令补全面板——抽出通用 `CompletionPopup`，命令与文件提及共用同一套 ↑↓/Enter/Tab/Escape 键控与 a11y 关联。触发条件收紧为**草稿起始** `/word`（`/^\/([\w-]*)$/`），使正文中后段的路径式 `/` 不再误开面板；条目展示 `/<name>` + frontmatter description，前缀匹配优先排序。mock 侧 `MockCodexApi.listSlashCommands` 从**已启用**插件的 `kind: command` 组件派生（与后端同源语义），`document-skills` fixture 增加一条 `summarize` 命令供无 Electron 环境自测。
- **顺带修复：** Escape 关闭面板后，textarea 的 `onKeyUp` 重新同步会因草稿仍以 `/`（或 `@`）开头而立刻把面板重新打开——该缺陷 **@-mention 原本也存在**。现改为 Escape 键的 keyup 不触发同步。
- **真链路 QA（CDP 9222，fixture `zprio-fixture@local`）：** `Temp\opencode\slash-completion-qa.mjs` → **10/10 PASS**：输入 `/` 弹出并含 `/demo` 与描述、`/de` 过滤、Enter 填入 `/demo ` 且自动关闭、非行首 `/` 不触发、Escape 关闭并保留草稿、@-mention 无回归、无匹配空态。安装后命令立即出现、卸载后立即消失（`slash-setup.mjs` / `slash-teardown.mjs`），双侧互证。

**9.6.2 `/demo hello` QA 数据点 —— 前端已补观察：内核展开正确，非内核问题**
- 真链路（CDP 9222，fixture `zprio-fixture@local`，session `0603cc3d-c98c-4297-94e3-12669b28790a`）：发送 `/demo hello` → 流内 **仅 1 条** `user_message`，content = `Summarize: hello\r\n`（`$ARGUMENTS`→`hello` 已展开）；原始 `/demo hello` **从未**进入事件流或 transcript。
- 与 §9.2 已知限制记录的「消息为原文」**不符**——事件层与 `openSession` transcript 均只见展开正文。若 UI 曾显示原文，应是 Composer 发送前的输入回显或另一次会话的误记；**本次不回传后端**。
- 遗留（归 9.6.1）：渲染层无 slash 补全列表；`/demo ` 不自动补全。展开正文的展示本身正常（流里就是展开后的文本）。
- 证据：`Temp\opencode\slash-expand-qa.mjs`（exit 0）、`Temp\opencode\slash-expand-qa.png`。
- **后端结论（本项关闭）**：接受该观察。与 P2b 设计一致——命令 handler 经 `pi.sendUserMessage` 注入**展开后**的 prompt，原文不入事件流；accept-plugins 单测（`$ARGUMENTS` 全量替换 + `sendUserMessage` 捕获）与本次真链路互证。后端无动作；§9.2 旧记录已由前端更正。唯一遗留项归 9.6.1（补全 UI + IPC）。

**9.6.3 提交纪律（不变）：** 后端批次未提交前，你继续只提交 `src/renderer/**` + 本文档；`git add` 指名文件，禁 `git add -A`。

**9.6.4 缺口审查后的第二批（前端轨）—— 渲染层能修的全部修完**

来源：`docs/gap-audit.md`（契约 ↔ `ipc.ts` 注册 ↔ preload 桥 ↔ 渲染层消费 四方交叉核对）。本批**只动 `src/renderer/**` + 文档**，未触碰 `src/main/**`、`src/preload/**`、`src/shared/**`（含 `kernel-protocol.ts`），也未动你们工作区的 MCP 在制品。

| 项 | 改动 | 说明 |
|---|---|---|
| A3 附件 | 新增 `components/composerAttachments.ts`；drop/paste 暂存真实 `File`，chip 可移除，被拒文件给出可见原因 | 契约无 `attachments` 字段且无上传通道，因此提交时把文本内容以 `--- name --- … --- end name ---` **内联进消息**；上限 5 个 / 单文件 64 KB / 单条 192 KB。**若你们将来加 `PromptInput.attachments`，这里换成真附件即可，内联块是过渡形态** |
| A5 删除会话 | 会话行菜单加 `Delete…`（面板内联二次确认，初始焦点在 Cancel）；`useChat.deleteSession` 调既有 API | `codex:deleteSession` 后端早已是真实现（kernel `disposeSession` + `terminals.disposeSession` + `registry.remove`），前端此前从未调用 |
| A6 覆盖层 | `clearSessionMeta`（删除时）+ `pruneSessionMeta`（每次成功 `listSessions` 后）+ 归档计数上开关 | `renameSession`/`archiveSession` 的 localStorage 覆盖层按 §7.1#4 保留，但不再残留会导致 id 复用后被旧标题污染 |
| B2 Projects | 侧栏可折叠 Projects 分区，按 `SessionSummary.cwd` 聚合 | **不引入新契约**：`cwd` 本就在 `listSessions` 里。选中即过滤聊天列表，主按钮变 `New chat in <项目>` 并在该目录建会话 |
| B4 Settings | 增 Shortcuts（读 `lib/shortcuts.ts` 真值表）与 Environment（真实桥接类型 / 平台 / 会话数 / 当前目录） | 只显示**真实存在**的信息，并明示"主题 / 重命名 / 归档仅存本机" |
| C2 | `respond` 取 sessionId 改走 `activeIdRef.current` | 与 `send`/`stop`/`applyFiles` 一致，消除快速切会话时把权限应答发给旧会话的窗口 |
| C3 | `lib/theme.ts` 加 `subscribeThemeChange`；`TerminalDrawer` 订阅后把实时 CSS 变量重算赋给 `term.options.theme` | 含 `preference = system` 时 OS 切换的场景（`<html>` 无变化，只有媒体查询变化） |
| F | `.gitignore` 加 `.workbuddy/`、`robot_gardener_story.*`、`scripts/diag-model-*.mjs` | 落实 §9.1「禁 `git add -A`」的机械保障 |

**故意不做（后端门控，不伪造控件）：** B3 Plan/Ask（需 `PromptMode` 扩枚举 + 内核语义）、B5 `userConfig` 保存、B6 MCP 配置 UI（两者都缺写回命令）、B7 非 stdio MCP、B8/B9/B10（`plugin-porting.md` 已定的产品范围）。理由与 A1 相同——做出来就是"点了没反应"的装饰性控件。

**QA：** CDP 9222 真链路走查（`Temp\opencode\gap-walkthrough.mjs` / `gap-walkthrough2.mjs`），覆盖 Projects 过滤、附件投放与拒绝原因、Settings 新分区、主题切换、终端配色跟随、删除二次确认与"确认前不删、确认后只删目标"。删除项走查会临时建一条会话并在验证后删除，走查前后会话总数一致。

**给后端的两个提示（都不阻塞）：**
1. `PromptInput.attachments` 一旦只增，前端把内联块换成真附件；在那之前附件内容会出现在 prompt 文本里，`user_message` 的 content 会因此变长（非 bug）。
2. 侧栏 Projects 依赖 `SessionSummary.cwd` 稳定可读——目前是绝对路径，正常。

