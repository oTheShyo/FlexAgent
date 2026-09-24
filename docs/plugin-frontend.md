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
