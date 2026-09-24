# 插件系统 · 后端实现计划（内核轨）

**上游设计：** [`docs/plugin-design.md`](./plugin-design.md)（先读）
**前端分工：** [`docs/plugin-frontend.md`](./plugin-frontend.md)
**契约权威：** [`src/shared/contract/index.ts`](../src/shared/contract/index.ts) + [`docs/contract.md`](./contract.md)
**改动边界：** 仅 `src/main/**`、`src/preload/**`、`src/shared/**`（只增契约）、`docs/**`。**不改** `src/renderer/**`（前端轨负责）。

---

## 0. 范围（P1）

**做：** extensions + skills 的本地插件管理闭环。
**不做：** commands、hooks、MCP、市场、`userConfig` 表单落盘（留 P2/P3）。

**P1 完成判据：**
1. `npm run typecheck` 双 tsconfig exit 0。
2. 能从一个本地目录安装插件（含 `plugin.json`），列表可见、可启停、可卸载。
3. 启用含 `extensions/index.ts` 的插件后，重启内核，该扩展对新 session 生效（`registerTool`/`on()` 可观察）。
4. 启用含 `skills/<名>/SKILL.md` 的插件后，PI 能发现该技能（启动诊断 / `/skill:名`）。
5. 新增验收脚本 `scripts/accept-plugins.mjs` → `ACCEPT_PLUGINS_PASS`。
6. mock fallback 仍绿（`MockCodexApi` 由前端轨补齐；后端保证真链路）。

---

## 1. 契约增量（v1.4）

### 1.1 `src/shared/contract/index.ts` 增补

**错误码**（追加进 `ContractErrorCode` 联合）：

```ts
  | 'PLUGIN_NOT_FOUND'
  | 'PLUGIN_ALREADY_INSTALLED'
  | 'PLUGIN_MANIFEST_INVALID'
  | 'PLUGIN_COMPONENT_INVALID'
  | 'PLUGIN_PATH_INVALID'
```

**类型**（放在错误区之后、命令区之前）：

```ts
// ─── Plugins (v1.4) ──────────────────────────────────────────────────────────

/** Stable plugin identity: `${name}@${source}` (source = 'local' | 'bundled' | marketplace name). */
export type PluginId = string
export type PluginSourceKind = 'bundled' | 'local' | 'marketplace'
export type PluginComponentKind = 'extension' | 'skill' | 'command' | 'hook' | 'mcp'

export interface PluginSource {
  kind: PluginSourceKind
  /** Display label, e.g. 'Local', 'Bundled', or a marketplace name. */
  label: string
}

export interface PluginSummary {
  id: PluginId
  name: string
  version: string
  description?: string
  enabled: boolean
  source: PluginSource
  componentCounts: Partial<Record<PluginComponentKind, number>>
}

export interface PluginComponentInfo {
  kind: PluginComponentKind
  name: string
  description?: string
  /** Path relative to the plugin root (POSIX). */
  path?: string
}

export interface PluginUserConfigSpec {
  key: string
  title: string
  description?: string
  type: 'string' | 'number' | 'boolean' | 'directory' | 'file'
  default?: string | number | boolean
  required?: boolean
  /** Sensitive values are masked and NOT writable from the UI in P1. */
  sensitive?: boolean
}

export interface PluginDiagnostic {
  code: string
  severity: 'error' | 'warning'
  message: string
  pluginId?: PluginId
}

export interface PluginDetail extends PluginSummary {
  author?: string | { name: string; email?: string; url?: string }
  homepage?: string
  keywords?: string[]
  /** Absolute path of the installed plugin root. */
  rootPath: string
  components: PluginComponentInfo[]
  userConfig?: PluginUserConfigSpec[]
  configuredOptions?: Record<string, string | number | boolean>
  diagnostics?: PluginDiagnostic[]
}

export interface InstallPluginInput {
  /** P1 only supports a local directory. P3 will add marketplace variants (discriminated union). */
  source: { kind: 'directory'; path: string }
}
```

**`CodexApi` 追加**（放在 `pickDirectory` 之后）：

```ts
  // ── Plugins (v1.4) ──
  /** All installed plugins (local + bundled). Global, not session-scoped. */
  listPlugins(): Promise<PluginSummary[]>
  /** Full detail for one plugin (components enumerated). */
  getPlugin(id: PluginId): Promise<PluginDetail>
  /** Toggle enable/disable. Idempotent (no-op success when unchanged). Source of truth = registry. */
  setPluginEnabled(id: PluginId, enabled: boolean): Promise<PluginSummary>
  /** Install from a local directory. Rejects PLUGIN_ALREADY_INSTALLED if id exists. */
  installPlugin(input: InstallPluginInput): Promise<PluginSummary>
  /** Remove from registry + delete installed dir (bundled → suppressed marker). */
  uninstallPlugin(id: PluginId): Promise<void>
```

**`KernelEvent` 追加**：注意——`pluginsChanged` **不是 session 事件**，但现有投递模型是 session-scoped + `seq`。P1 采用**独立全局通道**，不塞进 `KernelEvent`（避免污染 seq 语义）：

```ts
/** Plugins changed (install/enable/disable/uninstall). Delivered on a SEPARATE channel (IPC.pluginsChanged). */
export interface PluginChangeEvent {
  plugins: PluginSummary[]
}
```

**`IPC` 追加**：

```ts
  // plugins (v1.4)
  listPlugins: 'codex:listPlugins',
  getPlugin: 'codex:getPlugin',
  setPluginEnabled: 'codex:setPluginEnabled',
  installPlugin: 'codex:installPlugin',
  uninstallPlugin: 'codex:uninstallPlugin',
  /** main → renderer push for PluginChangeEvent (global, per webContents). */
  pluginsChanged: 'codex:pluginsChanged'
```

### 1.2 `src/shared/kernel-protocol.ts` 增补

worker 重载请求（下发启用插件的资源规格）：

```ts
export interface PluginResourceSpec {
  /** Absolute paths to extension files/dirs (PI additionalExtensionPaths). */
  extensionPaths: string[]
  /** Absolute skill root dirs of enabled plugins (PI skills discovery). */
  skillRoots: string[]
  /** Where to look for resource dirs (worker cwd varies per session; here = plugin storage root). */
  pluginStorageRoot: string
}

// WorkerRequest 追加：
  | { requestId: string; type: 'reloadPlugins'; resourceSpec: PluginResourceSpec }
```

---

## 2. 新增后端文件

### 2.1 `src/main/pluginManifest.ts` — manifest 解析与组件枚举

职责（纯函数，无 IO 副作用除读文件）：

- `findManifestPath(rootPath): string | null` — 发现优先级 `.flex-plugin/` → `.zcode-plugin/` → `.claude-plugin/` → 根 `plugin.json`。
- `parseManifest(path): { manifest: FlexPluginManifest; diagnostics: PluginDiagnostic[] }` — JSON 解析 + 字段校验（`name` 正则 `^[a-z0-9][a-z0-9._-]{0,127}$`）。非法 → 抛 `ContractError('PLUGIN_MANIFEST_INVALID')`（仅安装时）或记诊断（列举时容错）。
- `enumerateComponents(rootPath, manifest): { components: PluginComponentInfo[]; extensionPaths: string[]; skillRoots: string[]; diagnostics: PluginDiagnostic[] }`
  - `extensions`：解析声明三态 → 存在的 `.ts`/`.js` 文件或目录（目录取其 `index.ts`/`index.js`）；缺省探测 `extensions/`。
  - `skills`：解析声明三态 → 含 `SKILL.md` 的子目录；读 frontmatter `name`/`description`；缺省探测 `skills/`。
  - `commands`/`hooks`/`mcpServers`：P1 **仅登记计数 + 记 `plugin_unsupported_component`(warning)**，不加载。
- `readPluginDetail(rootPath, record): PluginDetail` — 组装详情（含 `userConfig` 规格、诊断）。

**复用 zcode 经验：** 组件按目录布局自动识别；未实现字段记诊断不阻断。

### 2.2 `src/main/pluginRegistry.ts` — 持久化注册表

**镜像 `src/main/registry.ts` 的 SessionRegistry 模式**（Map + `load()`/`persist()` + `version: 1`）。

```ts
export interface PluginRecord {
  id: PluginId              // `${name}@${source}`
  name: string
  version: string
  rootPath: string          // 安装后的绝对路径
  enabled: boolean
  sourceKind: PluginSourceKind
  sourceLabel: string
  configuredOptions?: Record<string, string | number | boolean>
  suppressed?: boolean      // bundled 卸载后不再复活
  installedAt: number
}

export class PluginRegistry {
  load(): void
  list(): PluginRecord[]
  get(id: PluginId): PluginRecord | undefined
  require(id: PluginId): PluginRecord
  add(rec: PluginRecord): void
  remove(id: PluginId): void
  setEnabled(id: PluginId, enabled: boolean): PluginRecord
  /** Enabled plugins → resource spec for the worker. */
  collectResourceSpec(): PluginResourceSpec
  private persist(): void   // userData/plugins/installed.json
}
```

- 路径：`join(app.getPath('userData'), 'plugins', 'installed.json')`。
- 安装目录：`join(app.getPath('userData'), 'plugins', '<name>@local')`。

### 2.3 `src/main/plugins.ts` — 业务编排（IPC 调它）

```ts
export class PluginService {
  constructor(private registry: PluginRegistry, private kernel: KernelHost, private notify: () => void) {}

  list(): PluginSummary[]
  get(id: PluginId): PluginDetail
  async install(input: InstallPluginInput): Promise<PluginSummary>   // 校验→拷贝→add→默认 enabled→notify+reload
  async setEnabled(id: PluginId, enabled: boolean): Promise<PluginSummary>
  async uninstall(id: PluginId): Promise<void>
  async reloadKernel(): Promise<void>   // 触发 kernel 重启以让 resourceLoader 生效
}
```

**安装流程（P1 本地目录）：**
1. 校验 `input.source.path` 存在且为目录 → 否则 `PLUGIN_PATH_INVALID`。
2. `findManifestPath` → 无 → `PLUGIN_MANIFEST_INVALID`。
3. `parseManifest` → 得 `name`。
4. `id = ${name}@local`；`registry.get(id)` 存在 → `PLUGIN_ALREADY_INSTALLED`。
5. 拷贝目录到 `userData/plugins/<name>@local`（跳过 `node_modules`/`.git`，或直接用 `cp -r`）。
6. `registry.add({... enabled: true})`。
7. `notify()`（广播 `pluginsChanged`）+ `reloadKernel()`。

**加载 → 注入链（核心）：**
```
PluginService.reloadKernel()
  → const spec = registry.collectResourceSpec()
  → kernel.request({ type: 'reloadPlugins', resourceSpec: spec })   // worker 记下 spec
  → kernel 重启（见 §3.2）
```

### 2.4 `src/main/pluginLoader.ts`（可选拆分）— 路径解析辅助

把 `enumerateComponents` 的路径解析（声明三态、glob、默认目录）与 markdown frontmatter 解析抽成小函数，便于单测。

---

## 3. 改动现有文件

### 3.1 `src/main/worker.ts` — 构造 `DefaultResourceLoader`

**当前（L422-423）：**
```ts
const { createAgentSession } = await loadPi()
const { session } = await createAgentSession({ cwd, sessionManager })
```

**改为：**
```ts
// 模块级：保存 main 下发的插件资源规格
let pluginResourceSpec: PluginResourceSpec = { extensionPaths: [], skillRoots: [], pluginStorageRoot: '' }

// attachSession 内：
const { createAgentSession, DefaultResourceLoader, getAgentDir } = await loadPi()
const resourceLoader = new DefaultResourceLoader({
  cwd,
  agentDir: getAgentDir(),
  additionalExtensionPaths: pluginResourceSpec.extensionPaths,
  // skills：默认发现 + 收窄到启用插件的 skillRoots（P1：把 plugin skillRoots 追加进发现）
  // 若 PI 的 skillsOverride 签名需 current → 合并 plugin skillRoots 后返回
})
await resourceLoader.reload()
const { session } = await createAgentSession({ cwd, sessionManager, resourceLoader })
```

> **实现注意：** 需先确认 `DefaultResourceLoader` 是否原生支持"追加 skill 根"。若仅支持 `skillsOverride(current)`，则用 `loadSkillsFromDir(skillRoot)` 手动加载 plugin 技能后合并进 `current.skills`。**待实现时以 `dist/index.d.ts` 的类型签名为准**（已确认导出 `loadSkills`/`loadSkillsFromDir`/`Skill`/`createSyntheticSourceInfo`）。

**新增请求分支：**
```ts
case 'reloadPlugins': {
  pluginResourceSpec = req.resourceSpec
  // 不需要立刻重建已存在 session；由 main 重启 worker 生效（P1）
  return undefined
}
```

**`createSession`/`openSession`** 无需改（`attachSession` 已读取模块级 spec）。

### 3.2 `src/main/kernel.ts` — 支持"受控重启以让插件生效"

复用现有 `recoverFromWorkerLoss` 的自动重启。新增公开方法：

```ts
/** Restart the worker to apply a new plugin resource spec. Known sessions get error+idle; client reconciles via openSession. */
async restartForPlugins(): Promise<void> {
  const w = this.worker
  if (!w) { this.start(); return }
  this.worker = null                 // 阻止 exit handler 双触发 recovery
  await w.terminate()
  this.failAll(new Error('Kernel restarting for plugin change'))
  this.seq.clear()
  this.runStates.clear()
  this.start()
}
```

> 顺序要点：先 `worker = null` 再 `terminate()`，避免 `exit` handler 走 §7.2.2 的 error fanOut（插件变更是**预期**重启，不应向 UI 抛断连 error）。若希望 UI 明确感知，可**替代**为在 `restartForPlugins` 里主动 fanOut 一条 `run_state: idle`（不抛 error）。

**此方法与 §7.2.2 的区别要写清注释：** 崩溃恢复 = 非预期（error+idle）；插件重载 = 预期（静默或仅 idle）。

### 3.3 `src/main/ipc.ts` — 5 个 handler

在 `registerIpcHandlers` 签名加参数：`plugins: PluginService`。

```ts
ipcMain.handle(IPC.listPlugins, () => guard(() => plugins.list()))
ipcMain.handle(IPC.getPlugin, (_e, id: unknown) =>
  guard(() => {
    if (typeof id !== 'string' || !id) throw new ContractError('INVALID_INPUT', 'id is required')
    return plugins.get(id)
  }))
ipcMain.handle(IPC.setPluginEnabled, (_e, input: { id?: unknown; enabled?: unknown }) =>
  guard(() => {
    if (!input || typeof input.id !== 'string' || typeof input.enabled !== 'boolean')
      throw new ContractError('INVALID_INPUT', 'id and enabled are required')
    return plugins.setEnabled(input.id, input.enabled)
  }))
ipcMain.handle(IPC.installPlugin, (_e, input: InstallPluginInput) =>
  guard(() => {
    if (!input || input.source?.kind !== 'directory' || typeof input.source.path !== 'string' || !input.source.path)
      throw new ContractError('INVALID_INPUT', 'source.directory.path is required')
    return plugins.install(input)
  }))
ipcMain.handle(IPC.uninstallPlugin, (_e, id: unknown) =>
  guard(() => {
    if (typeof id !== 'string' || !id) throw new ContractError('INVALID_INPUT', 'id is required')
    return plugins.uninstall(id)
  }))
```

**IPC 错误码白名单**：`ipc.ts` 和 `preload/index.ts` 里的 `CONTRACT_ERROR_CODES` Set **都要补 5 个插件错误码**，否则会被降级成 `KERNEL_INTERNAL`。

### 3.4 `src/preload/index.ts` — 5 个桥方法 + 事件

```ts
listPlugins: () => invoke<PluginSummary[]>(IPC.listPlugins),
getPlugin: (id: PluginId) => invoke<PluginDetail>(IPC.getPlugin, id),
setPluginEnabled: (id: PluginId, enabled: boolean) => invoke<PluginSummary>(IPC.setPluginEnabled, { id, enabled }),
installPlugin: (input: InstallPluginInput) => invoke<PluginSummary>(IPC.installPlugin, input),
uninstallPlugin: (id: PluginId) => invoke<void>(IPC.uninstallPlugin, id),
```

**全局事件订阅**（非 session-scoped）：

```ts
subscribePlugins(listener: (event: PluginChangeEvent) => void): () => void {
  const handler = (_e: IpcRendererEvent, payload: PluginChangeEvent): void => listener(payload)
  ipcRenderer.on(IPC.pluginsChanged, handler)
  return () => { ipcRenderer.removeListener(IPC.pluginsChanged, handler) }
}
```

`CodexApi` 接口需同步加 `subscribePlugins`（在 contract 里声明）+ preload 补 5 错误码。

### 3.5 `src/main/index.ts` — 组装

```ts
registry.load()
const pluginRegistry = new PluginRegistry()
pluginRegistry.load()
kernel.start()
...
const pluginService = new PluginService(pluginRegistry, kernel, () =>
  broadcastPluginsChanged(pluginService.list())
)
registerIpcHandlers(kernel, registry, terminals, pluginService)
```

`broadcastPluginsChanged` 遍历 `BrowserWindow.getAllWindows()` 发 `IPC.pluginsChanged`（与 `kernel.fanOut` 同样的遍历方式，但走独立通道）。

### 3.6 `broadcast` 与加载时机

- 启动时 `kernel.start()` 之后要**首次下发** resourceSpec：可在 `PluginService` 构造后立刻 `kernel.request({type:'reloadPlugins', resourceSpec})`（此时无 session，仅设置模块级变量）。worker 在处理首个 `createSession` 前就会读到。

---

## 4. 验收计划

### 4.1 新增 `scripts/accept-plugins.mjs`

参照现有 `scripts/accept-model.mjs`（CDP + `window.electron.codex`）。**串行跑**（避免全局变量互踩，见 backend-handoff §7.3）。

覆盖：
1. `listPlugins()` 初始为 `[]`（或仅内置）。
2. 用临时目录 fixture（含 `.flex-plugin/plugin.json` + `extensions/index.ts` + `skills/demo/SKILL.md`）调 `installPlugin({ source: { kind: 'directory', path } })` → 返回 `PluginSummary`，`enabled: true`，`componentCounts` 含 `extension: 1`、`skill: 1`。
3. `listPlugins()` 含该插件。
4. `getPlugin(id)` → `components` 枚举正确（extension/skill 各 1），无 error 诊断。
5. 重复安装同目录 → reject `PLUGIN_ALREADY_INSTALLED`。
6. `setPluginEnabled(id, false)` → `enabled: false`；再 `setPluginEnabled(id, true)` 幂等 `true`。
7. `uninstallPlugin(id)` → `listPlugins()` 不含；再 `getPlugin(id)` → `PLUGIN_NOT_FOUND`。
8. 非目录路径安装 → `PLUGIN_PATH_INVALID`；无 manifest 目录 → `PLUGIN_MANIFEST_INVALID`。
9. 收 `pluginsChanged` 事件（装/启停各≥1次）。

**输出：** `ACCEPT_PLUGINS_PASS`（n/n）。

### 4.2 回归

```powershell
npm run typecheck
npm run dev -- -- --remote-debugging-port=9222
node scripts/accept-plugins.mjs        # ACCEPT_PLUGINS_PASS
node scripts/accept-model.mjs          # 不回归
node scripts/accept-mock-fallback.mjs  # 不回归
node scripts/accept-apply.mjs          # 不回归
node scripts/accept-disconnect.mjs     # 不回归（插件重载走的是预期重启，非 §7.2.2）
```

### 4.3 真链路人工抽查

- 装一个含 `extensions/index.ts`（`pi.registerTool` + `pi.on('agent_start')`）的插件 → 重启内核 → 新 session prompt，能触发扩展行为（工具可调用 / 日志可见）。
- 装一个含 `skills/demo/SKILL.md` 的插件 → 启动诊断含该技能 / `/skill:demo` 可用。

---

## 5. 风险与待验证

| # | 风险 | 处置 |
|---|------|------|
| 1 | `DefaultResourceLoader` 对"追加 skill 根"的具体签名 | 实现时读 `dist/index.d.ts`；退路：`loadSkillsFromDir` + `skillsOverride` 合并 |
| 2 | PI 扩展通过 jiti 直接加载 `.ts`，需 Node ≥ 22.19（已满足） | 无动作 |
| 3 | worker 重启会中断运行中的 run | 文档声明：启停插件会刷新会话；UI 显示"重新加载中" |
| 4 | 扩展 `.ts` 有 npm 依赖 | P1 仅支持无外部依赖或已随插件带的扩展；有 `package.json` 依赖的走 P2/P3（PI packages 的 `pi install`） |
| 5 | `pluginsChanged` 非 session-scoped，与现投递模型不同 | 独立 IPC 通道 `codex:pluginsChanged`，不塞 `KernelEvent`/seq |

---

## 6. 实现顺序（建议）

1. 契约：contract/index.ts 类型 + 错误码 + IPC + kernel-protocol（typecheck 会红，前端轨并行补 mock）。
2. `pluginManifest.ts`（枚举 + 解析）→ 单跑。
3. `pluginRegistry.ts`（持久化）。
4. `worker.ts` resourceLoader 接缝 + `reloadPlugins` 分支。
5. `kernel.ts` `restartForPlugins`。
6. `plugins.ts`（PluginService 编排）。
7. `ipc.ts` 5 handler + 错误码白名单。
8. `preload/index.ts` 5 方法 + `subscribePlugins`。
9. `index.ts` 组装 + 首次下发 spec。
10. `scripts/accept-plugins.mjs` + 回归。
