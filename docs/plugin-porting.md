# 插件系统 · zcode 选择性移植矩阵（P2/P3 权威依据）

**上游设计：** [`docs/plugin-design.md`](./plugin-design.md)
**决策（用户批准）：** 选择性移植 zcode 宿主侧成熟模块；**不能直搬的参考其设计、适配 PI 内核**；不做全抄。
**勘察来源：** [zai-org/ZCode](https://github.com/zai-org/ZCode) @ `328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f`（Apache 2.0，2026-09-20 开源）+ PI `@earendil-works/pi-coding-agent` dist 类型实测。

**总判定：`partially portable`** —— 发现/安装/来源解析/hooks 文件层是自包含的 fs/json/http/git 代码（约 7k 行）可直搬；生命周期编排、RPC、agent 循环注入、宿主 UI 与 ZCode 的 config/IPC/引擎强耦合，只能参考重写。

---

## 1. 许可证义务（Apache 2.0）

移植任何 zcode 源文件时**必须**：
1. 保留文件头/原 LICENSE 声明；在 `NOTICE` 或 `THIRD_PARTY_NOTICES.md` 中列出被移植文件及来源 SHA。
2. 修改过的文件标注 "Modified from zai-org/ZCode"。
3. 不移植其商标/品牌资源。

（zcode 插件**格式**本身是公开规范，按规范实现不构成代码复制，无移植义务。）

---

## 2. 移植矩阵

图例：**COPY** = 直搬（去 ZCode 专属依赖）；**ADAPT** = 保格式/语义、生效层重写为 PI；**REFERENCE** = 仅参考设计，代码自写；**SKIP** = 不做。

### 2.1 宿主侧核心（零 PI 耦合 → COPY）

| # | 组件 | 源文件（`apps/zcode-cli/packages/` 下） | 动作 | 接入点（FlexAgent） |
|---|------|------|------|---------------------|
| C1 | marketplace 来源解析（github/git/url/file/directory 五形态；**npm 类型存在但未实现，抛 Unsupported——SKIP**） | `adapters/src/plugins/marketplace.ts` L221-271（parse）、L1517-1606（load switch） | **COPY** | `src/main/pluginMarketplace.ts`（P3，新建） |
| C2 | GitHub zipball 下载 + git 兜底 | `adapters/src/plugins/github-archive-source.ts` | **COPY** | 同上 |
| C3 | ZIP 安装包展开 | `adapters/src/plugins/zip-source.ts` | **COPY** | 同上 |
| C4 | 原子目录安装（stage→rename + 事务记录） | `adapters/src/plugins/atomic-directory.ts` | **COPY** | 替换 `pluginRegistry` 内复制逻辑 |
| C5 | 安装注册表磁盘布局（`installed_plugins.json`、`known_marketplaces.json`、`cache/`、`data/`、`marketplaces/`） | `marketplace.ts` L47-48、L561-574；`bootstrap/src/app/paths.ts` L9-10 | **COPY**（采用 zcode 布局获生态兼容；P1 的 `installed.json` 做迁移读取） | `pluginRegistry.ts` 扩展（P3） |
| C6 | `${userConfig.*}` 模板插值引擎 | `adapters/src/plugins/mcp.ts` L19（TEMPLATE_PATTERN）、L384-432（resolveTemplate，含敏感字段防泄漏） | **COPY**（删 official-auth 分支） | `src/main/userConfig.ts`（P2，hooks/MCP spawn 时注入） |
| C7 | hooks 文件发现（`hooks/hooks.json` + manifest.hooks） | `adapters/src/plugins/hook-sources.ts` | **COPY** | 桥扩展数据源（P2） |
| C8 | hooks 内存 runner + 输出协议（stdin/stdout JSON、超时、非 JSON 记 failed） | `core/hooks/runner.ts`、`configured-runner.ts`、`output.ts` | **COPY**（仅 runner/output；外依赖只有 `@zcode/contracts` + shared discovery，需 shim） | `src/main/hooks/hookRunner.ts`（P2） |
| C9 | manifest 发现补遗：`.codex-plugin/`、`.cursor-plugin/` 兼容目录、markdown frontmatter 解析 | `adapters/src/plugins/index.ts` L100-102、`markdown-frontmatter.ts` | **COPY**（合入现有 `pluginManifest.ts`） | `pluginManifest.ts`（P2） |
| C10 | 版本比较、source-errors、组件枚举 helpers | `version-compare.ts`、`source-errors.ts`、`plugin-components.ts`、`helpers.ts` | **COPY** | 随各消费方 |

**C 类 shim 需求（去 ZCode 依赖）：** `@zcode/contracts` → 换成本地 `src/shared/` 内部类型；`@zcode/shared` env sanitize → 精简本地实现；`@zcode/adapters/http` proxy fetch → 原生 fetch（或保留可选 proxy 参数）；`../skills/scan` → 已有 `pluginManifest.collectSkills` 替代。

### 2.2 生效层（PI 耦合 → ADAPT，走"桥扩展"）

**统一架构 —— 插件桥（plugin bridge）：** 一个**内联 ExtensionFactory**（`DefaultResourceLoaderOptions.extensionFactories` 直接注入，jiti 加载、无需落盘文件），读取 `PluginResourceSpec` 中 enabled 插件的 zcode 格式组件，翻译成 PI API：

| # | zcode 组件 | zcode 生效方式 | PI 落点（实测） | 动作 |
|---|-----------|---------------|----------------|------|
| A1 | `commands/*.md`（frontmatter name/description + body，`$ARGUMENTS`） | 内置斜杠命令，展开为 prompt | `pi.registerCommand(name, { handler })`（`types.d.ts` L963：name/description/getArgumentCompletions/handler(args, ctx)） | **ADAPT**：桥逐个注册；handler 内做 `$ARGUMENTS` 替换 → ctx actions 注入为用户 prompt（实现时读 `ExtensionCommandContextActions` L1365） |
| A2 | `hooks/hooks.json`（7 类事件，子进程 stdin/stdout JSON） | 引擎在对应生命周期 spawn 子进程 | `pi.on('session_start' \| 'session_before_compact' \| 'session_compact' \| 'session_shutdown' \| 'session_before_switch' …)` + tool 执行边界事件 | **ADAPT**：桥订阅 PI 事件 → 查映射表 → 调 C8 runner spawn 子进程；事件映射见 §3 |
| A3 | `skills/<名>/SKILL.md` | 目录扫描注入 | `additionalSkillPaths` | ✅ **P1 已交付** |
| A4 | 插件 JS 扩展（zcode 无对等物；PI 独有） | — | `additionalExtensionPaths` | ✅ **P1 已交付**（PI 原生路径，非 zcode 概念） |
| A5 | `agents/*.md`（子代理定义） | 引擎注册 subagent profile | PI 无 subagent 资源类型；`agentsFiles` 是 AGENTS.md 类上下文注入，语义不同 | **REFERENCE**（P3 再议：先作为诊断计数 + warning，与 P1 对 commands/mcp 的处理一致） |
| A6 | `userConfig` 表单值 | 存 config.json，MCP/hook spawn 时 `${}` 注入 | C6 插值 + 宿主 `userData/plugins/user-config.json` 存储 | **ADAPT**：存储自写（薄），插值 COPY |

### 2.3 MCP（PI 无原生支持 → REFERENCE，P2.5 单列）

| # | zcode 组件 | 事实 | 动作 |
|---|-----------|------|------|
| R1 | `.mcp.json` / manifest.mcpServers，命名空间 `plugin:<名>:<服务名>`，stdio spawn | PI 全 dist 对 `mcpServers`/`ModelContextProtocol` **零匹配** —— 内核不带 MCP | **DELIVERED（P2.5）**：`pluginMcp.ts`（配置枚举+插值，main 侧）+ `mcp/mcpClient.ts`（手写 newline-delimited JSON-RPC 2.0 stdio client）+ worker `pi.registerTool` 桥接（工具名 `mcp__<server>__<tool>`，zcode `name.ts` 惯例）。http/sse → `plugin_unsupported_mcp` warning 不 spawn；official-auth 机制 SKIP。 |
| R2 | `__zcode-plugin-host` re-exec、`mcp-official-auth.ts` | ZCode 引擎专属 | **SKIP** |

### 2.4 不移植（REFERENCE only，已有自写实现或强耦合）

| # | 组件 | 源 | 不搬理由 |
|---|------|-----|---------|
| X1 | 安装/启停编排、存储锁、官方种子 | `bootstrap/src/plugins.ts`（1457 行） | 绑 config-factory、官方插件硬编码；我们的 `plugins.ts` PluginService 已覆盖等价职责（P1 验收绿） |
| X2 | RPC 面 `plugins/*` + workspace/session 参数 | `bootstrap/src/zcode-protocol/plugins.ts` | 绑 zcode-protocol JSON-RPC；我们已有 contract v1.4 IPC（只增不改原则） |
| X3 | agent 循环注入（hooks@turn、plugin MCP 入 runtime、subagents） | `core/runtime/methods/hooks.ts` 等 | 绑 `AgentRuntimeInternal`；由桥扩展的 `pi.on` 替代 |
| X4 | 宿主旧插件服务 | `packages/services/src/plugins/pluginsService.ts` | **官方已退役 stub**（"Legacy plugin management has been retired"），活路径是引擎 RPC——抄了也是死代码 |
| X5 | 宿主 PluginStore UI（~8k 行） | `packages/ui/src/settings/Plugin*` | 绑 ZCode service DI；我们的 PluginsPage 已交付 |
| X6 | 信任/审核栈（workspace-hook trust/review） | `core/hooks/workspace-hook-*` | 绑 zcode-protocol-v4；P1 已有"启用 = 授权执行"模型，hooks 沿用即可 |
| X7 | bundled/official 插件种子、plugin-sync 远程同步 | `bootstrap/src/bundled-plugins.ts`、`packages/services/src/plugin-sync/` | 产品专属，P3 市场阶段再评估 |
| X8 | hooks 事件词表中的 ZCode 专属语义 | `contracts/src/hooks` | 事件**名字**保留 Claude 兼容集（生态插件按此写 hooks.json），触发**时机**由 §3 映射到 PI |

---

## 3. hooks 事件映射表（A2 的核心）

zcode/Claude 兼容 hooks.json 事件 → PI ExtensionAPI `on()` / 工具边界：

| hooks.json 事件 | PI 落点 | P2 范围 |
|-----------------|---------|---------|
| `SessionStart` | `pi.on('session_start')` | ✅ |
| `SessionEnd` | `pi.on('session_shutdown')` | ✅ |
| `PreCompact` / `SessionCompact` | `pi.on('session_before_compact')` / `pi.on('session_compact')` | ✅ |
| `PreToolUse` / `PostToolUse` | `pi.on('tool_execution_start')` / `pi.on('tool_execution_end')`（`types.d.ts` L674/L689） | ✅（matcher 按 tool name；**决策点**：PostToolUse 拒绝语义 = 事件返回值能否 veto，实现时核实 `ExtensionHandler<R>` 返回类型） |
| `UserPromptSubmit` | 无直对等（PI 无 prompt 提交边界事件） | ⚠️ P2 先记 diagnostic 不阻断；可后续用 command handler 包一层 |
| `Notification` / `Stop` / `SubagentStop` | `pi.on('agent_settled')` 近似 Stop | ⚠️ P2.5 |
| 子进程协议 | COPY zcode runner（stdin JSON 入参、stdout JSON 出参、timeoutMs、非 JSON = failed） | ✅ |
| 环境变量 | 兼容注入 `ZCODE_PLUGIN_ROOT/_DATA/_ID/_NAME` + 并行注入 `FLEX_PLUGIN_*`（同值），保证 zcode 生态插件脚本直接可用 | ✅ |

---

## 4. PI 能力落点速查（实测自 dist 类型）

| PI 接口 | 位置 | 用途 |
|---------|------|------|
| `additionalExtensionPaths` / `additionalSkillPaths` | `resource-loader.d.ts` L72-73 | A4 / A3（P1 已接） |
| `extensionFactories?: InlineExtension[]` | 同上 L76；`loadExtensionFromFactory`（`loader.d.ts` L16） | **桥扩展注入点（本方案核心）** |
| jiti 加载（TS/ESM/CJS 通吃） | `extensions/jiti-loader.d.ts` | 桥及插件扩展无需转译 |
| `pi.registerCommand` | `types.d.ts` L963-969 | A1 |
| `pi.registerTool` | `types.d.ts` L1019 | R1 MCP 桥 |
| `pi.on(...)` 事件族 | `types.d.ts` L971+（session_*、tool_execution_*、agent_*、turn_*） | A2 |
| `skillsOverride` / `promptsOverride` / `agentsFilesOverride` | `resource-loader.d.ts` L85-116 | 诊断/兜底通道 |
| **无 MCP** | 全 dist `mcpServers`/`ModelContextProtocol` 零匹配 | R1 必须自研桥 |

---

## 5. P2/P3 排期（依矩阵）

| 阶段 | 内容 | 矩阵条目 | 验收 |
|------|------|---------|------|
| **P2a** | 桥扩展骨架（extensionFactories 注入、读 PluginResourceSpec 组件清单）+ manifest 补遗 | A4 已有、C9、桥骨架 | typecheck + 现有 29/29 回归绿 |
| **P2b** | commands → registerCommand | A1 | 新 accept：装含 `commands/demo.md` 插件 → 桥注册 `/demo`（验收脚本可断言 spec/诊断；真触发需 LLM 交互则记人工抽查项） |
| **P2c** | hooks：发现 + 插值 + runner + 事件映射 | C6、C7、C8、A2、§3 | 新 accept：含 `hooks/hooks.json` 的插件，session 生命周期 spawn 子进程且输出被 runner 记录（可在验收中直接调 runner 单测式断言） |
| **P2.5** | MCP 桥（可裁剪） | R1 | 装含 `.mcp.json` 插件 → 工具出现且命名空间正确 |
| **P3** | 市场：来源解析 + 注册表布局 + 原子安装 + dependencies 闭包 + install provenance | C1-C5、C10 | 新 accept：本地 marketplace.json 目录安装；github 源联网安装（标记 slow） |

**回归底线：** 每阶段结束 `npm run typecheck` + `scripts/accept-plugins.mjs` 29/29 + 既有 accept-* 脚本全绿。

---

## 6. 与 P1 的存储/契约关系

- **契约**：P2/P3 若需新字段/事件，遵守 contract 头注释"只增不改"；PI 类型不进 contract。桥扩展内部类型不导出。
- **存储**：P1 `userData/plugins/installed.json` 保持可读；P3 引入 zcode 布局时**并存迁移**（读旧写新或读新写旧，实现于 registry 层，不破坏 P1 验收）。
- **重启语义**：不变——组件 spec 仍"先重启再下发"（见 plugin-backend.md §7.5C 更正）；桥随 `extensionFactories` 在新 worker 内自然重建。

---

## 7. P2a+P2b 交付状态

| 项 | 状态 |
|----|------|
| 桥扩展骨架 `createPluginBridgeFactory`（`DefaultResourceLoaderOptions.extensionFactories` 注入，读 `PluginResourceSpec`，随 restart-then-deliver 在新 worker 重建） | ✅ 已交付（`src/main/pluginBridge.ts`） |
| C9 manifest 补遗：发现优先级 `.flex-plugin` → `.zcode-plugin` → `.claude-plugin` → `.codex-plugin` → `.cursor-plugin` → 根 `plugin.json`（首命中即用） | ✅ 已交付 |
| `commands/*.md` → `pi.registerCommand`（frontmatter `name`/`description`、文件名 stem 兜底、`$ARGUMENTS` 全量替换、首注册优先防冲突） | ✅ 已交付 |
| 命令投递动作 | handler 调 `ExtensionAPI.sendUserMessage(expanded)`（`types.d.ts` L1055；`ExtensionCommandContextActions` L1365 无 prompt 投递动作，非 ctx 所有） |
| `PluginResourceSpec` 增量 | `commands` / `hooks` / `mcp`（后两者空占位，P2c/P2.5 填充） |
| frontmatter 解析 | 自写最小解析（PI `parseFrontmatter` 静态引入会在 CJS worker 内 `require` ESM-only 包而失败；动态引入会拖成异步且 manifest 需同步解析） |
| 验收 | `accept-plugins.mjs` 新增桥单测式检查（stub pi + 临时目录）+ C9/`command` 枚举 CDP 检查；协议/存储/重启顺序未变 |
| 人工抽查（脚本不覆盖） | 装含 `commands/demo.md` 的插件 → 启用并重启内核 → 新会话输入 `/demo <参数>`，确认展开后的 prompt 被投递执行（LLM 交互） |

---

## 8. P2c 交付状态（hooks：C6 + C7 + C8 + A2）

### 8.1 COPY/ADAPT 判定

| 条目 | 源（zai-org/ZCode @ `328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f`） | 动作 | 落点 |
|------|------|------|------|
| C6 `${user_config.*}` 插值引擎（敏感字段抛错、缺失抛错、session/skill 上下文抛错、未知模板原样保留） | `apps/zcode-cli/packages/adapters/src/plugins/mcp.ts`（TEMPLATE_PATTERN 及 resolveTemplate 插值语义；删 official-auth 分支） | **COPY** | `src/main/userConfig.ts`（`${user_config.*}` / `${userConfig.*}` 双前缀；`resolveUserConfigValues` 默认值合并；`interpolateHookArgs`） |
| C7 hooks 文件发现（标准 `hooks/hooks.json` + manifest.hooks 路径；逃逸/缺失/重复/内联对象诊断码） | `apps/zcode-cli/packages/adapters/src/plugins/hook-sources.ts` | **COPY** | `src/main/hookSources.ts` |
| C8 hooks runner + 输出协议（stdin/stdout JSON、超时、截断、exit 语义） | `apps/zcode-cli/packages/core/src/hooks/runner.ts`、`configured-runner*.ts`、`output.ts`；超时/大小常量 `packages/shared/src/workspace-hook-config.ts` L7-8（`60_000` / `32_768`） | **ADAPT**（原生 lean runner，去 `@zcode/contracts` 依赖；语义见 §8.3） | `src/main/hooks/hookRunner.ts` |
| matcher 语义（`*` / 管道拆分 / 正则兜底） | `apps/zcode-cli/packages/core/src/hooks/output.ts` | **COPY** | `src/main/pluginBridge.ts`（`matchesHookMatcher`） |
| A2 事件桥接 | §3 映射表 | **ADAPT** | `src/main/pluginBridge.ts`（`HOOK_EVENT_MAP`、`registerPluginHooks`、`buildHookStdin`） |
| 插值上下文注入 | — | 自写（薄） | `pluginRegistry.collectResourceSpec` → `spec.hookContexts`（`PluginHookContext` 增量字段，`kernel-protocol.ts`） |

### 8.2 事件映射实现（§3 落地）

| hooks.json 事件 | PI 事件 | 状态 |
|-----------------|---------|------|
| `SessionStart` | `session_start` | ✅ |
| `SessionEnd` | `session_shutdown` | ✅ |
| `PreCompact` | `session_before_compact` | ✅ |
| `SessionCompact` / **`PostCompact`** | `session_compact` | ✅（**偏差记录**：PI 无 `session_after_compact` 事件，`PostCompact` 并入 `session_compact` 触发——不伪造 PI API） |
| `PreToolUse` / `PostToolUse` | `tool_execution_start` / `tool_execution_end` | ✅（matcher 按 `payload.toolName`；PostToolUse stdin 附 `tool_response`/`is_error`） |
| `UserPromptSubmit` 等未映射事件 | — | 聚合**一条** `plugin_unsupported_hook`（severity `warning`，列出排序后的事件名），不阻断注册 |
| 拒绝语义（block） | — | exit 2 → runner `blockRequested` → 桥记 `hook_block_ignored`（**P2c 不做 veto**，P2.5 接入内核决策） |

实现注：PI 仅在 `session.bindExtensions()` 内 emit `session_start`，且该方法不出现在任何 worker 嵌入路径——`worker.attachSession` 在 `createAgentSession` 之后显式调用 `await session.bindExtensions({ mode: 'print' })`（bindings 全部可选），否则 SessionStart 永不触发。其余 6 个映射事件均出自核心路径，无需额外接线。该接线为活体抽查实测发现并修复。

### 8.3 runner 语义（§3 简写与 zcode 实测的差异，以 zcode 实行为准）

- exit 0 + **非 JSON stdout → `ok`，`output` 为 undefined**（zcode 实际行为；§3 表中"非 JSON = failed"为矩阵简写——实际仅对**已解析字段的 schema 违例**记 `failed` + `hook_output_invalid`）
- exit 2 → `ok` + `blockRequested` + `blockReason`（stderr/stdout trim，4000 上限）
- 其他非零 → `failed` + `hook_exit_nonzero`（携带 stderr trim）；超时 → `timeout` + `hook_timeout`（默认 60000ms；win32 `taskkill /pid /T /F`）；spawn 失败（error 事件且 pid undefined）→ `spawn_error` + `hook_spawn_error`
- 每流 32768 字节截断（`truncated` 标志）；stdin 写入后即 `end()`
- 环境变量（spawn 时叠加覆盖同名）：`CLAUDE_/ZCODE_/FLEX_PROJECT_DIR` = cwd；`CLAUDE_/ZCODE_/FLEX_PLUGIN_ROOT`、`_DATA`；`ZCODE_/FLEX_PLUGIN_ID`、`_NAME`（CLAUDE 前缀无 `_ID`/`_NAME`，与 zcode 对齐）。`dataPath` = `<pluginStorageRoot>/data/<pluginId>`（无 storageRoot 时回退 `<pluginRoot>/.flex-plugin/data`），注册时 mkdir

### 8.4 限制（诚实记录）

- stdin 不含 `session_id` / `transcript_path`：PI `ExtensionContext` 仅实测到 `cwd`（`types.d.ts`），**不伪造字段**
- manifest.hooks 内联对象 → `plugin_unsupported_component`（仅支持文件路径声明）
- 插值上下文无运行时 session 变量 → `${CLAUDE_CODE_SESSION_ID}` 等抛错 → `hook_interpolation_failed` 诊断且不 spawn
- block veto 未接入内核决策 → `hook_block_ignored`（P2.5）
- 运行期桥诊断（`hook_block_ignored` / `hook_timeout` / `hook_exit_nonzero` 等）记入 bridge diagnostics 数组；worker 当前不向渲染层转发 bridge 运行期诊断（与 P2a command 诊断同一现状），插件可见诊断来自枚举期 `getPlugin().diagnostics`（`plugin_unsupported_hook` 走该路径）
- worker 退出前排空 in-flight hook（`inflightHookRuns` + `settleHookRuns`：50ms 等待后 `Promise.race([allSettled, 2000ms])` 再 `process.exit`）为 electron worker_thread 行为，plain-Node 不可测 → 源码断言 + 人工抽查

### 8.5 验收（2026-09-24 全绿）

- `accept-plugins.mjs` → **ACCEPT_PLUGINS_PASS，113/113**（原 44 项字节未动 + 新增 69 项 hook 检查）
- 新增检查覆盖：4 模块 type-stripped 导入；C6 插值（默认/别名/插件与项目变量/未知保留/敏感/缺失/session/skill 抛错）；7 项映射 + matcher（star/管道/正则/非法正则/无值）；C7 发现与解析诊断矩阵（标准/重复/逃逸/缺失/内联/enabled:false/空 matcher/超时单位换算）；C8 runner 全状态机（stdin+env overlay echo、非 JSON ok、schema 违例、exit 1/2、超时 300ms、ENOENT、截断、超时解析、env overlay 纯函数）；桥 fire 测试（注册 5、unsupported 聚合一次、matcher 跳过 read 命中 write、env/stdin marker、插值双诊断 Missing+Sensitive、block 诊断）；worker 布线源码断言（`hookDeps` 进 factory、`settleHookRuns` 排空）；CDP 装 `accept-hook-fixture@local` → `componentCounts.hook=2`、组件 `PostToolUse`/`SessionStart` @ `hooks/hooks.json`、`UserPromptSubmit` warning 诊断 → 卸载
- `npm run typecheck` EXIT=0；`accept-model` 11/11、`accept-mock-fallback`、`accept-apply` 全绿（EXIT=0）
- 人工抽查（脚本不覆盖）：① 装含 `hooks/hooks.json`（SessionStart 写标记文件）的插件 → 新建会话 → **标记文件生成且 6 字段（event/root/data/id/name/proj）全部命中，SPOTCHECK_1_PASS（clean build 复验通过）**；② 会话进行中杀 worker 等待 in-flight 结束为 electron worker_thread 行为，plain-Node 不可测 → 以 `settleHookRuns` 源码断言（accept worker 布线检查）代替，活体不执行

### 8.6 P2c 移植清单（供主会话合并进 `THIRD_PARTY_NOTICES.md`；本 agent 未改该文件）

| 源文件（@ `328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f`） | 落点 | 性质 |
|------|------|------|
| `apps/zcode-cli/packages/adapters/src/plugins/mcp.ts`（TEMPLATE_PATTERN、resolveTemplate 插值语义） | `src/main/userConfig.ts` | COPY-adapted |
| `apps/zcode-cli/packages/adapters/src/plugins/hook-sources.ts` | `src/main/hookSources.ts` | COPY-adapted |
| `apps/zcode-cli/packages/core/src/hooks/output.ts`（matcher 语义） | `src/main/pluginBridge.ts`（`matchesHookMatcher`） | COPY（片段） |
| `apps/zcode-cli/packages/core/src/hooks/runner.ts`、`configured-runner*.ts` + `packages/shared/src/workspace-hook-config.ts` L7-8（60_000 / 32_768 常量） | `src/main/hooks/hookRunner.ts` | ADAPT |
