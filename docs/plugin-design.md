# FlexAgent 插件系统设计（v1.4 · 权威设计）

**读者：** 后端/内核轨 + 前端轨**都先读本文**，再读各自的分工文档：
- 后端实现计划 → [`docs/plugin-backend.md`](./plugin-backend.md)
- 前端实现计划 → [`docs/plugin-frontend.md`](./plugin-frontend.md)
- 契约权威类型 → [`src/shared/contract/index.ts`](../src/shared/contract/index.ts) + [`docs/contract.md`](./contract.md)

**一句话：** FlexAgent 插件 = **zcode 风格的声明式打包格式**（manifest + 目录布局）＋ **PI 稳定扩展机制作为唯一执行运行时**（`DefaultResourceLoader` → `createAgentSession`）。

---

## 0. 背景与研究结论

### 0.1 参考对象：zcode（[zai-org/ZCode](https://github.com/zai-org/ZCode)）

zcode 的插件系统核心：**插件是声明式的能力打包格式，不是代码框架**。

- 一个文件夹：`.zcode-plugin/plugin.json`（唯一必需）＋ 组件目录（`skills/`、`commands/`、`agents/`、`hooks/`、`.mcp.json`）。
- 组件**按目录布局自动识别**，manifest 只描述元数据 + 组件路径 + `userConfig`。
- 生命周期：发现 → 安装（市场依赖闭包 + 原子激活）→ 启用/停用 → 加载（枚举组件）→ 注入 agent 循环。
- 插件本体**不进 agent 进程**：Hook 走子进程 stdin/stdout JSON；MCP 走标准协议并加命名空间 `plugin:<名>:<服务名>`。
- 不支持/未实现的字段（`lspServers` 等）→ **记结构化诊断、不阻断加载**。
- 停用 ≠ 卸载；变更后自动刷新受影响的技能与会话；启用 = 授予代码执行信任（有明确安全提示）。

### 0.2 FlexAgent 现状（硬事实）

| 事实 | 证据 |
|------|------|
| Electron 单包应用，IPC 桥（**非** HTTP） | `src/shared/contract/index.ts`、`src/preload/index.ts`、`src/main/ipc.ts` |
| 插件占位 = 侧栏一个**死按钮** | `src/renderer/src/components/Sidebar.tsx` L264 `<NavRow icon={<PluginsIcon />} label="Plugins" />`（无 `onClick`）；`插件` 全库零匹配 |
| 无路由 | `App.tsx` 用布尔态切换视图（`showTerminal`/`showReview`/`showPalette`） |
| 内核 = `@earendil-works/pi-coding-agent` ^0.87.1 | `package.json` L15；`electron.vite.config.ts` external |
| worker **当前未传 `resourceLoader`** | `src/main/worker.ts` L423 `createAgentSession({ cwd, sessionManager })` |
| 契约 v1.3，只增不改；PI 类型禁止外泄 | `contract/index.ts` 头注释、`docs/backend-handoff.md` §6 |

### 0.3 PI 扩展面（本设计的地基）——**已核实**

PI 有三条稳定路径，FlexAgent 全部可用：

1. **Extensions（TS，可执行）** — `export default (pi: ExtensionAPI) => {...}`，`pi.registerTool/Command/Shortcut/Flag/Provider/on(...)`。
   来源：`node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`；样例 `examples/sdk/06-extensions.ts`。
2. **Skills（声明式，已稳定）** — `skills/<名>/SKILL.md`，Agent Skills 规范；`DefaultResourceLoader` 负责发现/过滤。
   来源：`docs/skills.md`；样例 `examples/sdk/04-skills.ts`；导出 `loadSkills`/`loadSkillsFromDir`/`Skill`/`createSyntheticSourceInfo`。
3. **Pi Packages（分发格式）** — 目录/npm 包，`package.json` 的 `pi` 键声明 `extensions`/`skills`/`prompts`/`themes`。
   来源：`docs/packages.md`。

**关键注入接缝（唯一）：** `new DefaultResourceLoader({ cwd, agentDir, additionalExtensionPaths, extensionFactories, skillsOverride, promptsOverride, ... })` → `await loader.reload()` → `createAgentSession({ resourceLoader: loader, ... })`。

> **重要更正（相对 `backend-handoff.md` §7.5C）：** §7.5C 写"技能/连接器 → 等 PI skill API 接入"。
> **PI 的 skill API 已经就绪**（`DefaultResourceLoader` + `04-skills.ts`），因此 **skills 可以在 P1 一并交付**，不必再等。

**明确排除：** PI 的 `./experimental/plugin`（Chord facets、`PI_EXPERIMENTAL=1`、仅源码导出、不随包分发）——实验性且不适用，**不采用**。

---

## 1. 概念模型

**FlexAgent 插件 = 一个文件夹**，包含：

1. **清单** `plugin.json`（唯一必需）——元数据、组件声明、`userConfig`。
2. **组件**（按需，全部可选）：
   - `extensions/*.ts` — **可执行** PI 扩展（P1 核心）。
   - `skills/<名>/SKILL.md` — 声明式技能（P1）。
   - `commands/*.md` — 斜杠命令（P2，经宿主桥注册到 PI）。
   - `hooks/hooks.json` — 事件钩子（P2，经宿主桥映射到 PI `on()`）。
   - `.mcp.json` — MCP 服务（P2，承载方式待验证）。

启用插件的组件会被"编译"成 PI 的加载配置，注入到 worker 的 `DefaultResourceLoader`；停用则从配置中移除。

### 1.1 组件映射表（P1 范围）

| 组件 | 格式 | P1 运行时承载 | 阶段 |
|------|------|--------------|------|
| **extension** | `extensions/*.ts` | PI `additionalExtensionPaths`（官方样例 `06-extensions.ts`） | **P1** |
| **skill** | `skills/<名>/SKILL.md` | PI `DefaultResourceLoader` skills 发现（`04-skills.ts`）＋ `skillsOverride` 收窄到启用插件 | **P1** |
| command | `commands/*.md` | FlexAgent 宿主扩展读 frontmatter → `pi.registerCommand` | P2 |
| hook | `hooks/hooks.json` + 子进程 | FlexAgent 宿主扩展订阅 `pi.on()` → 按 zcode stdin/stdout JSON 协议拉起子进程 | P2 |
| mcp | `.mcp.json` | 待验证 PI 承载方式；命名空间 `plugin:<名>:<服务名>` | P2 |

### 1.2 关键决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| manifest 兼容 | 自有 `.flex-plugin/plugin.json`；发现回退 `.zcode-plugin/` → `.claude-plugin/` → 根 `plugin.json` | 复用 zcode 已验证 schema 与生态；markdown 组件两边同源 |
| 执行模型 | 可执行组件**只有 PI extensions**；skills 声明式；commands/hooks/mcp 由 FlexAgent 宿主桥 | 内核即 PI，不自造沙箱 |
| 启停生效 | **P1：复用 kernel 重启 + SessionRegistry 恢复**（§7.2.2 崩溃恢复链） | `resourceLoader` 在 session 创建时注入；重启链路已验证 |
| 信任模型 | 启用 = 授予本地代码执行信任；详情页先展示全部组件再启用 | 与 zcode 安全口径一致 |
| 实验性 Chord 插件 | **不用** | 实验门控、仅源码导出 |

---

## 2. Manifest 与目录

### 2.1 目录布局

```
my-plugin/
├── .flex-plugin/
│   └── plugin.json          # 唯一必需（发现回退见 §1.2）
├── extensions/              # PI ExtensionAPI 模块（P1）
│   └── index.ts
├── skills/<名>/SKILL.md     # P1
├── commands/*.md            # P2
├── hooks/hooks.json         # P2
└── .mcp.json                # P2
```

**清单发现优先级**（首个命中即用）：
`.flex-plugin/plugin.json` → `.zcode-plugin/plugin.json` → `.claude-plugin/plugin.json` → `plugin.json`

### 2.2 `plugin.json`

```jsonc
{
  "name": "hello-flex",                          // 必需 ^[a-z0-9][a-z0-9._-]{0,127}$
  "version": "0.1.0",                            // 缺省 "0.0.0"，语义化
  "description": "一句话描述",
  "author": { "name": "...", "url": "..." },      // 或字符串
  "homepage": "https://...",
  "repository": "https://...",
  "license": "MIT",
  "keywords": ["..."],
  "extensions": "extensions",                    // 字符串 | 数组 | 内联（zcode 三态）
  "skills": "skills",
  "commands": "commands",                        // P2 登记
  "hooks": "hooks/hooks.json",                   // P2 登记
  "mcpServers": ".mcp.json",                     // P2 登记
  "dependencies": ["other-plugin@market"],       // P3 生效；P1 读到 → warning 诊断
  "userConfig": {
    "api_key":   { "title": "API 密钥", "type": "string", "required": true, "sensitive": true },
    "max_retry": { "title": "重试次数", "type": "number", "default": 3 }
  }
}
```

**组件声明三态**（对齐 zcode `commands`/`skills`/`hooks`/`mcpServers`/`agents`）：目录字符串 / 路径数组 / 内联对象。缺省时按约定目录名探测。

**未实现字段**（`channels`/`lspServers`/`outputStyles`/`settings`）→ 记 `plugin_unsupported_component` 诊断，不阻断加载。

### 2.3 `userConfig` 项

| 字段 | 含义 |
|------|------|
| `type` | `string` / `number` / `boolean` / `directory` / `file` |
| `title` | 界面标题 |
| `description` | 说明 |
| `default` | 默认值 |
| `required` | 是否必填 |
| `sensitive` | 敏感值：**P1 界面禁写**；P2 走 `safeStorage` |

### 2.4 存储

```
userData/
├── plugins/
│   ├── installed.json          # PluginRegistry（镜像 SessionRegistry 模式）
│   └── <name>@<source>/        # 安装的插件根目录（拷贝）
```

`installed.json` 记录：`id`(`name@source`)、`name`、`version`、`rootPath`、`enabled`、`source{kind,label}`、`configuredOptions`、`suppressed`。

---

## 3. 总体架构

```
┌─ Renderer ───────────────────────────────────────────────┐
│ PluginsPage（列表 / 详情 / 空态）                          │
│   ↓ codexApi（契约 v1.4 增量）                             │
├─ Preload ────────────────────────────────────────────────┤
│ window.electron.codex.*                                   │
├─ Main ───────────────────────────────────────────────────┤
│ ipc.ts（guard 边界校验）                                   │
│ PluginRegistry  ── userData/plugins/installed.json         │
│ collectPluginResourceSpec(enabled)                         │
│   ↓ WorkerRequest: reloadPlugins { resourceSpec }          │
├─ Worker（PI 内核）───────────────────────────────────────┤
│ new DefaultResourceLoader({ cwd, agentDir,                 │
│     additionalExtensionPaths, skillsOverride })            │
│   → await reload()                                         │
│   → createAgentSession({ resourceLoader })                 │
└──────────────────────────────────────────────────────────┘
```

### 3.1 生命周期

1. **发现**：扫描 `userData/plugins/` 下已安装目录 + （P1 可选）内置插件根。
2. **安装**：本地目录 → 校验 manifest → 拷贝到 `userData/plugins/<name>@local/` → 写 `installed.json`（默认 enabled）。
3. **启用/停用**：改 `installed.json` → 通知 worker 重载 → 广播 `pluginsChanged`。
4. **加载**：main 把启用插件的 `extensionPaths` / `skillRoots` 汇总成 `PluginResourceSpec`，随 `reloadPlugins` 请求下发 worker。
5. **注入**：worker 用该 spec 构造 `DefaultResourceLoader`，`createAgentSession` 时带上。
6. **卸载**：删除目录 + 记录（内置插件写 `suppressed`，升级不复活，对齐 zcode）。

### 3.2 启停生效方式（P1）

resourceLoader 只在 session 创建时注入。P1 采用**最简可靠方案**：启用/停用后 → main 触发 **worker 重启** → 已知 session 走 §7.2.2 恢复链（`error`+`idle` fanOut → seq 清 → 自动重启）→ 用户 `openSession` 对账恢复（`piSessionFile` 已在 registry）。

- 复用现有已验证机制，风险最低。
- 后续可升级为 session 级热重载（PI `ResourceLoader.reload()` + 重建 session），P1 不做。

### 3.3 安全模型

- **启用 = 授予本地代码执行信任**（PI 扩展与插件同进程、同 OS 权限）。
- 详情页在启用前展示完整组件清单。
- `sensitive` 配置 P1 禁写。
- P1 仅支持**本地目录**安装（选择目录本身即显式信任动作）；市场（P3）需额外审查 UI。

---

## 4. 契约增量（v1.4 · 摘要，详见 plugin-backend.md）

全部定义在 `shared/contract`，**无 PI 类型**；错误统一 `ContractError`；`ipc.ts` 边界校验。

```ts
type PluginId = string                      // "name@source"
type PluginSourceKind = 'bundled' | 'local' | 'marketplace'
type PluginComponentKind = 'extension' | 'skill' | 'command' | 'hook' | 'mcp'

interface PluginSummary {
  id: PluginId; name: string; version: string; description?: string
  enabled: boolean
  source: { kind: PluginSourceKind; label: string }
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

// CodexApi 只增
listPlugins(): Promise<PluginSummary[]>
getPlugin(id: PluginId): Promise<PluginDetail>
setPluginEnabled(id: PluginId, enabled: boolean): Promise<PluginSummary>
installPlugin(input: InstallPluginInput): Promise<PluginSummary>
uninstallPlugin(id: PluginId): Promise<void>
subscribePlugins(listener: (event: PluginChangeEvent) => void): () => void

// 变更通知：**独立全局通道**，不走 KernelEvent / 不进 session seq（见后端文档）
interface PluginChangeEvent { plugins: PluginSummary[] }
```

**错误码（缺口补充进 `ContractErrorCode`）：** `PLUGIN_NOT_FOUND`、`PLUGIN_ALREADY_INSTALLED`、`PLUGIN_MANIFEST_INVALID`、`PLUGIN_COMPONENT_INVALID`、`PLUGIN_PATH_INVALID`。

---

## 5. 分期

| 阶段 | 内容 |
|------|------|
| **P1（本次）** | manifest 解析 + 组件枚举 + 本地安装/启停/卸载 + `PluginRegistry` + 契约 5 方法 + `pluginsChanged` + worker resourceLoader 接缝（**extensions + skills**）+ PluginsPage/详情/空态 + CommandPalette 入口 |
| **P2** | commands + hooks 宿主桥（zcode JSON 协议）、MCP（先验证 PI 承载）、`userConfig` 表单 + `safeStorage`、内置官方插件 + `suppressed` |
| **P3** | 市场：`marketplace.json`（兼容读 zcode 源）、7 种 source、依赖闭包安装 + 环检测、检查更新、市场源管理面板 |

---

## 6. 与现有文档的关系

- 本文**替代** `backend-handoff.md` §7.5C 中"技能等 PI skill API"的结论（skill API 已就绪）。其余 §7.5C 内容仍有效。
- 契约版本从 **v1.3 → v1.4**；`docs/contract.md` §8 版本表已同步。
- 分工：后端读 [`plugin-backend.md`](./plugin-backend.md)，前端读 [`plugin-frontend.md`](./plugin-frontend.md)。
