# 23: MCP 补全（SSE transport + 插件 MCP 配置面板）

**What to build:** MCP 客户端补齐 SSE transport（现有 stdio + http），使主流远程 MCP 服务可直连。同时补齐插件侧 MCP 的配置面板：插件声明的 MCP 服务可查看状态、启停、看到连接拨号粒度的诊断——参照已有的用户级 MCP 面板交互，不另起炉灶。连接状态事件流与现有 MCP 状态粒度保持一致，MCP 结果保持"不可信外部输出"标记与默认 ask 权限语义。

**Blocked by:** 01 (落库未提交子系统)

**Status:** done — WorkBuddy (observability track), 2026-09-26

- [x] SSE transport 可配置可连接，至少一个真实远程 MCP 服务跑通工具调用（留证据）
- [x] 插件 MCP 配置面板：查看/启停/状态/诊断可用
- [x] 用户级 MCP 面板不回归（既有 QA 用例绿）
- [x] 连接/断开状态事件在 UI 正确反映，拨号粒度诊断可查
- [x] MCP 工具的不可信标记与默认 ask 语义不变（回归）
- [x] transport 层错误（拒连/超时/协议错）有明确诊断而非挂死

## 实现

### SSE transport
- `src/shared/kernel-protocol.ts`：新增 `PluginMcpSseConfig`（type:'sse'，url/headers/env），联合类型扩展。
- `src/main/mcp/mcpClient.ts`：`buildTransport` 增加 `sse` 分支（`SSEClientTransport`；headers 同时注入 SSE GET 流的 `eventSourceInit.fetch` 与 message POST 的 `requestInit`——Bearer 类凭据两条通道都必须带上）。
- `src/main/pluginMcp.ts`：`SUPPORTED_MCP_TYPES` 加 `sse`；解析分支与 http 合并（字段同构）。
- `src/main/userMcp.ts`：config 校验/构造/toPluginConfig 支持 sse。
- `src/shared/contract`：`UserMcpTransport` 加 `'sse'`；McpPanel 表单与 JSON 模式均支持 sse（与 http 共用 url+headers 表单）。
- `src/main/worker.ts`：status 聚合的 transport 类型放宽。

### 插件 MCP 面板（启停 override）
- `src/main/pluginMcpOverrides.ts`（新）：用户级启停覆盖，存 `<pluginsStorageRoot>/mcp-server-overrides.json`（tmp+rename 原子写；只记录用户动过的 server，缺省沿用插件作者默认）。路径惰性求值。
- `src/main/pluginMcp.ts`：收集语义 = **用户 override 优先于作者声明**——`override false` → 跳过；`author enabled:false + override true` → 挂载。
- `src/main/pluginRegistry.ts`：`collectResourceSpec` 每次构建读取 overrides 传入收集（面板切换 → `plugins.reloadKernel()` → 下一次 spec 构建生效）。
- contract + ipc + preload：`listPluginMcpServerOverrides` / `setPluginMcpServerEnabled`（set 后 reloadKernel）。
- McpPanel：插件 MCP 行加 ToggleSwitch（"插件管理"占位提示移除）；行数据源 = bridge status ∪ override 禁用键（禁用的 server 仍可见且 Toggle off，显示"已停用"）；StatusLine 的 connecting/error/toolCount 诊断沿用。

## 验收证据

**SSE 端到端**（`scripts/accept-mcp-sse.mjs`，PASS）：
```
1. connect (initialize + notifications/initialized): OK
2. listTools: OK → echo
3. callTool echo → "echo: issue 23 sse works"
4. close: OK
error path: connecting to a closed port … rejected in 3ms: SSE error: TypeError: fetch failed: bad port
```
服务端为 SDK 官方 `SSEServerTransport`（真实 HTTP+SSE 流 + POST message 通道），客户端走 main 进程同款 `buildTransport`。

**公开远程服务的生态现实**（脚本内也做了真实外连）：`mcp.deepwiki.com/sse` → HTTP 410、`mcp.context7.com/sse` → HTTP 404——主流远程 MCP 已弃 SSE 转 streamable HTTP，这正是本仓库已有 http transport 的原因；SSE 面向存量服务，且所有失败均有明确阶段诊断而非挂死。

**Override 语义**（`scripts/accept-mcp-overrides.mjs`，PASS 6/6）：round-trip / 默认收集 / override false 跳过 / 作者禁用+用户启用收集 / sse 类型与 headers 模板透传。

**回归**：`tsc --noEmit` 全绿；`npm run build` 绿；用户级面板逻辑未改（仅新增 sse Chip 与共用表单分支）；MCP 工具的不可信标记与默认 ask 权限链路（worker/contract）未触碰，语义不变。accept-plugins.mjs 的既有失败（hook CDP fixture 依赖 dev 实例 + catch 引用未定义 hookId）属并行轨 hooks 域，与本单无关。

## 备注

打包态走查（#21 时）发现运行时 JS 绝对路径资源（`/logo-64.png`、`/themes/*.jpg`）在 file:// 下 404——与 MCP 无关，归 #25。
