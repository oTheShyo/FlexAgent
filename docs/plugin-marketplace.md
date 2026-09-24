# 插件市场（P3）— 后端契约与接线说明

面向前端轨：本文描述 FlexAgent 主进程已实现的 marketplace 面、IPC 载荷形状、COPY-vs-ADAPT 对照，以及手工 QA 清单。**渲染进程 UI 由前端轨另行实现**；本轨只保证 preload 桥与契约类型可用。

## 1. 架构

```
renderer  ──(contextBridge)──►  preload: window.electron.marketplace
                                      │  ipcRenderer.invoke / on
                                      ▼
main: marketplaceIpc.ts  ──►  MarketplaceService (pluginMarketplace.ts)
                                      │
                    ┌─────────────────┼──────────────────┐
                    ▼                 ▼                  ▼
             PluginRegistry     marketplaceAtomic    zip / github / git
             (installed.json)   (stage→rename)       (下载与解压)
```

- **权威安装记录**仍是现有 `PluginRegistry`（`installed.json`）；市场侧额外落盘 `known_marketplaces.json`、`marketplaces/<id>/marketplace.json`、`cache/`、`data/`。
- **安装语义**：条目安装 id = `${name}@${marketplace}`，`sourceKind = 'marketplace'`，`sourceLabel = marketplace id`，落盘于 `cache/<mkt>/<name>/<version>/`；直接 path/url 安装 id = `${name}@marketplace`，label 为 `'Marketplace'`。
- **覆盖安装**：先 `registry.remove` 再 `registry.add`；冲突且未 `overwrite` → `PLUGIN_ALREADY_INSTALLED`；激活失败回滚 registry 记录。
- **依赖闭包**：`entry` 安装前解析 `dependencies`（支持 `name` 与 `name@mkt`）；环依赖 / 未允许的跨市场依赖 → `PLUGIN_SOURCE_INVALID`；失败回滚已激活目录与已写入的 registry 记录。
- **进度**：`MarketplaceService` → `onProgress` → main `BrowserWindow.webContents.send(IPC.marketplaceProgress)` → preload `subscribeMarketplaceProgress`。

## 2. IPC 通道与载荷

通道名（`src/shared/contract` → `IPC`）：

| 通道 | 方向 | 入参 | 返回 |
|---|---|---|---|
| `codex:listMarketplaces` | invoke | — | `MarketplaceInfo[]` |
| `codex:addMarketplace` | invoke | `AddMarketplaceInput` | `MarketplaceInfo` |
| `codex:searchMarketplaces` | invoke | `MarketplaceSearchInput` | `MarketplaceSearchResult[]` |
| `codex:installFromMarketplace` | invoke | `InstallFromMarketplaceInput` | `PluginSummary` |
| `codex:marketplaceProgress` | main→renderer push | — | `MarketplaceProgressEvent` |

### 类型摘要

```ts
interface MarketplaceInfo {
  id: string
  name: string
  description?: string
  source: string
  pluginCount: number
  addedAt: string
  lastUpdated?: string
}

interface MarketplaceSearchResult {
  marketplace: string
  name: string
  version?: string
  description?: string
  tags?: string[]
  installed: boolean
  installedVersion?: string
  updateAvailable?: boolean
}

interface MarketplaceSearchInput {
  query?: string
  marketplace?: string
}

interface AddMarketplaceInput {
  source: string  // HTTPS URL | owner/repo[#ref] | git SSH | 本地 .json / 目录
}

type MarketplaceInstallSource =
  | { kind: 'path'; path: string }
  | { kind: 'url'; url: string }
  | { kind: 'entry'; marketplace: string; name: string }

interface InstallFromMarketplaceInput {
  source: MarketplaceInstallSource
  overwrite?: boolean
}

type MarketplaceProgressPhase = 'resolve' | 'download' | 'extract' | 'install' | 'done' | 'error'

interface MarketplaceProgressEvent {
  phase: MarketplaceProgressPhase
  source?: string
  pluginId?: PluginId
  message?: string
}

interface MarketplaceApi {
  listMarketplaces(): Promise<MarketplaceInfo[]>
  addMarketplace(input: AddMarketplaceInput): Promise<MarketplaceInfo>
  searchMarketplaces(input: MarketplaceSearchInput): Promise<MarketplaceSearchResult[]>
  installFromMarketplace(input: InstallFromMarketplaceInput): Promise<PluginSummary>
  subscribeMarketplaceProgress(listener: (event: MarketplaceProgressEvent) => void): () => void
}
```

### Preload 用法

```ts
const mk = window.electron?.marketplace
await mk?.listMarketplaces()
const unsubscribe = mk?.subscribeMarketplaceProgress((e) => { /* phase 进度条 */ })
```

`MarketplaceApi` 与 `CodexApi` 分离；P1 mock 只需继续实现 `CodexApi` 即可通过类型检查。

### 错误码（新增）

| code | 含义 |
|---|---|
| `PLUGIN_SOURCE_INVALID` | 源字符串无法解析 / 不支持的 source kind / 系统 git 不可用 / 跨市场依赖被拒 / 依赖环 |
| `PLUGIN_DOWNLOAD_FAILED` | 远程拉取失败（网络、HTTP 状态、sha256、zip 安全拒绝、marketplace.json 解析失败） |

既有：`PLUGIN_PATH_INVALID`、`PLUGIN_MANIFEST_INVALID`、`PLUGIN_ALREADY_INSTALLED`、`PLUGIN_NOT_FOUND`、`INVALID_INPUT`。

Reject 形状与现有 `invoke` 一致：`{ name: 'ContractError', code, message, details }`。

### 源字符串语法（`AddMarketplaceInput.source` / path·url 安装）

| 形式 | 结果 |
|---|---|
| `https://github.com/owner/repo`（可 `#ref`） | git 源（优先 GitHub archive，失败回退 git） |
| `owner/repo[#ref]` 简写 | github 源 |
| `git@host:path` / `https://…/*.git` | git 源 |
| `https://…/marketplace.json` | URL JSON 索引 |
| 本地 `.json` 绝对/相对路径 | file 源 |
| 本地目录（含 `marketplace.json` / `.flex-plugin/` / `.claude-plugin/`） | directory 源 |
| `npm:…` 等 | **不支持** → `PLUGIN_SOURCE_INVALID` |

URL 安装：路径以 `.zip` 结尾（可带 `?sha256=`）→ zip；`github.com/owner/repo` 或 `*.git` → 仓库源；其它 → `PLUGIN_SOURCE_INVALID`。

## 3. COPY-vs-ADAPT 对照

| 矩阵 | 内容 | zcode 来源 | 分类 | 本仓库落点 / 调整 |
|---|---|---|---|---|
| C1 | marketplace 源解析 + load switch | `marketplace.ts` | **COPY** | `src/main/pluginMarketplace.ts`：增加 `.flex-plugin/marketplace.json` 候选；**去掉** X7 官方 seed/guards 与 `settings` 分支；`npm`/`pip` 明确 Unsupported |
| C2 | GitHub archive + git 回退 | `github-archive-source.ts` | **COPY** | `marketplaceGithub.ts`：原生 `fetch` + manual redirect；公开 HTTPS repo 才走 zipball |
| C3 | zip 安装 | `zip-source.ts` | **COPY** | `marketplaceZip.ts`：**yauzl → 纯 Node**（EOCD + central dir + `inflateRawSync` + `zlib.crc32`）；拒绝 `..`、加密位、symlink |
| C4 | 原子目录安装 | `atomic-directory.ts` | **COPY** | `marketplaceAtomic.ts`：stage→rename + 事务 JSON + backup 恢复；**不**替换 `pluginRegistry` 的 P1 安装路径 |
| C5 | 注册与落盘布局 | `marketplace.ts` / `paths.ts` | **COPY（部分 ADAPT）** | `known_marketplaces.json` + `marketplaces/<id>/` + `cache/` + `data/`；**不**写 `installed_plugins.json`（唯一权威仍是现有 `installed.json`） |
| C6 | `${user_config.*}` 插值 | `mcp.ts` resolveTemplate | **COPY** | `marketplaceTemplate.ts`：删除 official-auth 分支；补 `FLEX_*` 别名；**不**放在 `userConfig.ts`（避免与 P2c hooks 轨冲突）；运行时注入仍属 hooks/MCP spawn |
| C10 | version-compare / source-errors / helpers | 多文件 | **COPY** | `marketplaceVersionCompare.ts`（内联 semver，无外部依赖）、`marketplaceHelpers.ts`（source 红action → `ContractError`） |
| ADAPT | IPC 面 | — | **ADAPT** | `marketplaceIpc.ts`：复制现有 guard 模式（`ipc.ts` 不动）；扩展错误码集 |
| ADAPT | 进度广播 | — | **ADAPT** | `index.ts` 中 `broadcastMarketplaceProgress` → `IPC.marketplaceProgress` |
| SKIP | store 列表 / i18n / 官方市场 seed | — | **SKIP** | 非 P3 范围 |
| SKIP | P1 `pluginsChanged` 语义变更 | — | **SKIP** | 安装成功后经 `notify` 继续复用现有 `pluginsChanged` |

上游出处：`https://github.com/zai-org/ZCode` @ `328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f`（Apache-2.0），详见根目录 `THIRD_PARTY_NOTICES.md`。

## 4. 本轨文件

| 文件 | 角色 |
|---|---|
| `src/main/pluginMarketplace.ts` | 源解析、依赖闭包、`MarketplaceService` |
| `src/main/marketplaceZip.ts` | 纯 Node zip 读/校验/解压 |
| `src/main/marketplaceGithub.ts` | GitHub zipball + git 回退判定 |
| `src/main/marketplaceAtomic.ts` | 原子目录激活 |
| `src/main/marketplaceTemplate.ts` | C6 插值 |
| `src/main/marketplaceHelpers.ts` | 源错误 redaction、路径工具 |
| `src/main/marketplaceVersionCompare.ts` | 更新比较 |
| `src/main/marketplaceIpc.ts` | ipcMain 注册（独立 guard） |
| `src/preload/index.ts` | `window.electron.marketplace` + 2 个错误码 |
| `src/main/index.ts` | 构造 Service、注册 IPC、进度广播（**超出 MAY 列表的接线，已披露**） |
| `src/main/plugins.ts` | `uninstall` 对 `sourceKind === 'marketplace'` 删除 `rootPath`（**超出 MAY 列表，已披露**） |
| `src/shared/contract/index.ts` | 加法：错误码 / 5 通道 / Marketplace 段 |
| `scripts/accept-marketplace.mjs` | 纯 Node 验收（无 CDP） |
| `THIRD_PARTY_NOTICES.md` | 上游出处与改动 |

## 5. 手工 QA（前端轨 / 联调）

1. **列市场**：空状态 → `listMarketplaces()` 为 `[]`。
2. **添加本地目录市场**：指向含 `marketplace.json` 的目录 → 出现在列表，`pluginCount` 正确。
3. **添加 URL 市场**（可选，需网络）：`https://…/marketplace.json`。
4. **搜索**：空 query 列全部；子串过滤 name/description/tags；按 `marketplace` 限域；已安装行 `installed: true`，旧版本 `updateAvailable: true`。
5. **entry 安装**：选带依赖的条目 → 依赖一并安装；进度事件依次出现 `resolve → download → extract → install → done`；插件出现在 P1 列表，`source.kind = 'marketplace'`。
6. **path 安装**：本地目录 / `.zip`；重复安装 → `PLUGIN_ALREADY_INSTALLED`；勾选覆盖 → 版本号更新。
7. **url 安装**：GitHub 简写 / `.zip?sha256=`；拔网 → `PLUGIN_DOWNLOAD_FAILED`（或 git 不可用 → `PLUGIN_SOURCE_INVALID`）。
8. **卸载**：市场安装的插件卸载后 `cache/…` 目录被删除，registry 记录消失。
9. **进度订阅**：长安装期间 `subscribeMarketplaceProgress` 收到多 phase；卸载订阅后不再收到。
10. **错误面**：坏路径 → `PLUGIN_PATH_INVALID`；无 manifest → `PLUGIN_MANIFEST_INVALID`；依赖环 → `PLUGIN_SOURCE_INVALID`；进度 `error` phase 带 `message`。

## 6. 验收命令

```bash
npm run typecheck          # 期望 exit 0
node --check scripts/accept-marketplace.mjs
node scripts/accept-marketplace.mjs   # 期望 accept-marketplace: PASS (N/N)，exit 0
# 可选网络用例：
set FLEX_ACCEPT_NETWORK=1 && node scripts/accept-marketplace.mjs
```

## 7. 明确不做（本轨）

- 不改 `src/renderer/**`、`worker`/`pluginBridge`/`pluginRegistry`/`pluginManifest`、hook*、`kernel-protocol.ts`。
- 不跑 CDP / 不重启 9222 上的 dev app。
- 不执行任何 git 写操作。
- 不实现 store 官方市场 seed、UI 文案 i18n、`settings` 持久化分支。
