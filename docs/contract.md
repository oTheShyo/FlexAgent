# FlexAgent 跨进程契约 v1.3

**权威类型源：** [`src/shared/contract/index.ts`](../src/shared/contract/index.ts)  
**状态：** 冻结候选 — 双轨（前端 / 内核）共同遵守  
**演进规则：** 只增不改（新事件变体、可选字段）；不重命名、不复用已有字段语义  
**后端会话入口：** [`docs/backend-handoff.md`](./backend-handoff.md)（对接分工、已落地文件、M1–M6 验收）

---

## 1. 角色与边界

```
Renderer (React)          Main (orchestration)         Worker (kernel)
┌──────────────────┐      ┌──────────────────┐        ┌─────────────────────────┐
│ UI 组件          │      │ IPC 路由         │        │ createAgentSession()    │
│ useChat 状态机   │◄────►│ 会话生命周期     │◄──────►│ @earendil-works/        │
│ 只 import         │      │ 权限转发         │        │   pi-coding-agent       │
│ shared/contract  │      │ 不执行工具       │        │ PI 事件 → KernelEvent   │
└──────────────────┘      └──────────────────┘        └─────────────────────────┘
         ▲                        ▲
         │  今日：MockCodexApi    │  真链路：preload 桥（IPC 通道见契约 `IPC`）
         │  （renderer 内直连）    │
```

**UI 可依赖：** `CodexApi`、`KernelEvent` 及其字段语义。  
**UI 禁止依赖：** PI 类型、IPC 通道细节、mock 的 fixture 结构。  
**可丢弃：** mock 实现、IPC 传输细节。**不可丢弃：** 本契约。

---

## 2. 命令面（renderer → kernel）

| 方法 | 语义 | 成功 | 失败（reject `ContractError`） |
|------|------|------|-------------------------------|
| `listSessions()` | 全部会话摘要 | `SessionSummary[]` | `KERNEL_INTERNAL` |
| `createSession({ cwd, title? })` | 新建会话（cwd = 项目绝对路径） | 新 summary | `INVALID_INPUT`（cwd 空/非法） |
| `openSession(id)` | 恢复摘要 + 全量 transcript，幂等 | `SessionDetail` | `SESSION_NOT_FOUND` |
| `prompt({ sessionId, text, mode? })` | 提交用户输入；**在被接受时 resolve，不等 run 结束** | `PromptAck` | `SESSION_NOT_FOUND`、`INVALID_INPUT`（text 空） |
| `abort(sessionId)` | 中断当前 run；idle 时 no-op | `void` | `SESSION_NOT_FOUND` |
| `respondPermission({ … })` | 答复挂起的 `permission_request` | `void` | `SESSION_NOT_FOUND`、`PERMISSION_EXPIRED` |
| `terminalCreate({ sessionId, cols, rows, cwd?, env? })` | 创建真 PTY（main / node-pty） | `{ terminalId }` | `SESSION_NOT_FOUND`、`INVALID_INPUT`、`TERMINAL_LIMIT`、`KERNEL_INTERNAL` |
| `terminalInput({ terminalId, data })` | 写 PTY master | `void` | `TERMINAL_NOT_FOUND`、`INVALID_INPUT` |
| `terminalResize({ terminalId, cols, rows })` | 调整 PTY 窗口 | `void` | `TERMINAL_NOT_FOUND`、`INVALID_INPUT` |
| `terminalKill(terminalId)` | 杀掉 PTY；对已死 id 幂等成功 | `void` | `TERMINAL_NOT_FOUND` |
| `applyFileChanges({ sessionId, files })` | Diff Accept：把 `FileChange.patch` 写到 session `cwd` 下（main 独占 fs，不进 transcript）；**幂等**（已是目标内容 → `alreadyApplied`） | `{ applied, alreadyApplied, failed[] }` | `SESSION_NOT_FOUND`、`SESSION_BUSY`（run 中）、`INVALID_INPUT` |
| `listModels()` | 可用模型（provider 已鉴权）；**不依赖** session | `ModelOption[]` | `KERNEL_INTERNAL` |
| `getModelConfig(sessionId)` | 当前会话生效的 model + thinking | `ModelConfig` | `SESSION_NOT_FOUND` |
| `setModel({ sessionId, provider, id, thinkingLevel? })` | **仅本会话**切换模型（`persist: false`）；可选同切 thinking | 生效后的 `ModelConfig` | `SESSION_NOT_FOUND`、`INVALID_INPUT`（未知 model） |
| `setThinkingLevel({ sessionId, level })` | **仅本会话**设思考强度（PI 按模型能力 clamp） | 生效后的 `ModelConfig` | `SESSION_NOT_FOUND`、`INVALID_INPUT` |
| `pickDirectory()` | 原生目录选择器（Choose project）；取消 → `null` | `string \| null` | `KERNEL_INTERNAL` |

**PTY 安全边界（有意为之）：** 真 PTY **不经过** agent 权限门——用户手动输入即以应用进程的 OS 权限执行完整 shell。Agent 的 `bash` 工具调用仍是另一条路径（`tool_*` + `permission_request`）。`cwd` 默认取所属 session 的工作目录。

### 2.0 模型与思考（v1.3）

```ts
type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
interface ModelOption { provider: string; id: string; label?: string }
interface ModelConfig {
  model: ModelOption | null
  thinkingLevel: ThinkingLevel
  availableThinkingLevels?: ThinkingLevel[]
}
```

- **会话作用域：** `setModel` / `setThinkingLevel` 不写 PI 全局 default（session-only）。
- **返回值权威：** 以调用后返回的 `ModelConfig` 为准（含 PI clamp 后的 `thinkingLevel`、`availableThinkingLevels`）。
- **不新增事件：** 变更通过命令 ack 同步；UI 乐观更新后用返回值对账即可。

### 2.1 `prompt` 的 steer / followUp（对齐 PI 硬约束）

PI：`session.prompt()` 在流式进行中**必须**声明 steer 或 followUp，否则 reject。

| 当前 `runState` | `mode` | 内核行为 | `PromptAck.disposition` |
|-----------------|--------|----------|-------------------------|
| `idle` | 忽略 | 启动新 run | `started` |
| `running` | 省略或 `'steer'` | 当前 assistant turn 的工具批结束后注入 | `steering` |
| `running` | `'followUp'` | 等 run 将 settle 时再注入 | `queued` |

**UI 默认：** 运行中按 Enter = 省略 mode（→ steer）；显式「排队发送」= `followUp`。

### 2.2 权限决策

- `allowOnce` — 仅放行该 `toolCallId`
- `allowSession` — 本会话内同 `name` 的后续调用直接放行（内核缓存，不进入 transcript）
- `deny` — 该工具调用失败（`tool_end.isError: true`），run 可继续

---

## 3. 事件面（kernel → renderer）

**投递模型：** 按 `sessionId` 订阅（非 per-prompt generator），保证 steer / permission / abort 在 run 中途可用。

**顺序保证：** 同一 session 内 `seq` 单调、从 0 起连续；缺口 = 丢事件，UI 应视为不可靠并可重新 `openSession` 对账。

### 3.1 事件目录

| `type` | 触发时机 | UI 消费方式 |
|--------|----------|-------------|
| `run_state` | 仅在 `idle↔running` 跳变时 | 状态条、Composer 可用性、Stop 按钮 |
| `user_message` | 用户消息进入 transcript（直接 prompt / steer 生效时 / followUp 实际入队执行时） | 追加用户气泡（可做乐观更新后对账） |
| `text_delta` | 助手流式文本 | 追加到当前 assistant buffer |
| `message_end` | 一条消息定稿 | **权威内容**：按 `message.id` 替换 partial |
| `tool_start` | 工具开始 | 工具卡片；`name==='bash'` 时同时作为终端时间线条目 |
| `tool_update` | 工具增量输出 | append 到同 `toolCallId` 的 buffer（bash stdout） |
| `tool_end` | 工具结束 | 卡片收尾；`isError` 红色 |
| `permission_request` | `beforeToolCall` 将挂起 | **模态/内联确认 UI**；在 `respondPermission` 前该工具不执行 |
| `file_changes` | 一次 run 内文件变更**全量快照**（替换式，非增量） | Diff 面板 `files` 字段 |
| `error` | run 内异步失败 | 内联错误；run 之后仍可能 `run_state: idle` |
| `pty_output` | node-pty `onData` | Terminal 抽屉按 `terminalId` append 字节流 |
| `pty_exit` | PTY 进程退出 | 终端标记 dead，禁止再 `terminalInput` |

### 3.2 与 PI 事件的映射（内核轨实现时对照）

| PI | KernelEvent |
|----|-------------|
| `agent_start` / turn 活跃 | `run_state: running`（仅首次跳变） |
| `agent_settled` | `run_state: idle`（**唯一** idle 来源；不要用 `agent_end`） |
| `message_start` (user) | `user_message` |
| `message_update` + `text_delta` | `text_delta` |
| `message_end` | `message_end` |
| `tool_execution_start` | `tool_start` |
| `tool_execution_update` | `tool_update` |
| `tool_execution_end` | `tool_end` |
| `beforeToolCall` 返回 block → 等待 UI | `permission_request` + 挂起 |
| `abort()` 结束 | 最终 `run_state: idle`（可先发 `error` code 可选扩展） |
| edit/patch 类工具结果聚合 | `file_changes`（PI **无**原生事件，内核必须自聚合） |
| compaction / retry / 队列内部通知 | v1 **不映射**（需要时只增 `notice` 变体） |

### 3.3 Terminal 抽屉语义（真 PTY — v1.1 决策）

**推翻 v1「工具时间线」方案。** Terminal = 交互式真 shell：

```
创建   → terminalCreate({ sessionId, cols, rows, cwd? }) → { terminalId }
输入   → terminalInput({ terminalId, data })            （键盘/粘贴）
输出   → pty_output { terminalId, data }                （append）
resize → terminalResize({ terminalId, cols, rows })
退出   → pty_exit { terminalId, exitCode }              （此后 input → TERMINAL_NOT_FOUND）
销毁   → terminalKill(terminalId)                       （幂等）
```

- **宿主：** main 进程 + `node-pty`（原生模块，不进 worker/renderer）
- **归属：** PTY 挂在 `sessionId` 下；`pty_*` 事件走该 session 的 `subscribe` 信封（共享 `seq`）
- **每 session 存活 PTY 上限：** 内核强制（建议 4），超限 `TERMINAL_LIMIT`
- **与 agent bash 的关系：** 两条独立通道，互不映射；不再用 `tool_start` 拼终端时间线
- **验收 mock（M6）：** `terminalCreate` 返回假 id → 伪造成对的 `pty_output` 回显 → `terminalKill` 后 `pty_exit`，再 input → `TERMINAL_NOT_FOUND`

### 3.4 Diff 面板数据

- 契约类型 `FileChange`：`{ path, status, additions, deletions, patch }`
- `patch` = unified diff 文本；现有 `DiffPanel.parsePatch` 已按此解析，**兼容**
- `path` 相对 session `cwd`，POSIX 分隔符
- `file_changes` 是**快照替换**：UI 每次直接 `setFiles(event.files)`
- **Accept（`applyFileChanges`）：** 调用方传入完整 `files`（含 `patch`）；main 校验路径不逃出 `cwd`；真内核下 agent 已可能写盘 → 命中目标内容记 `alreadyApplied` 不算失败
- **Reject：** 纯 UI（关面板 / 清本地 files）；**不做**磁盘回滚（v1.2 决策，回滚如需再只增命令）

---

## 4. Mock 行为规格（前端轨 Unit 2 验收）

Mock 实现 `CodexApi`，**必须**可演示以下路径（M1–M5 + M6 缺一不可验收）：

### M1 — 基本流式 run
```
prompt(idle) → ack{started}
→ run_state:running
→ user_message
→ tool_start(read_file) → tool_end
→ text_delta×N → message_end(assistant)
→ file_changes([modified src/…, patch 含 @@ hunks])
→ run_state:idle
```

### M2 — steer 插话
`running` 中第二次 `prompt`（不带 mode 或 `steer`）→ `ack{steering}` → 迟于当前工具批出现新的 `user_message`，run 不中断。

### M3 — followUp 排队
`running` 中 `prompt({ mode:'followUp' })` → `ack{queued}` → 在即将 `run_state:idle` 前出现该 `user_message`，并再跑一轮（再次 running…idle）。

### M4 — 权限阻塞
某个约定工具（建议首次 `bash`）发 `permission_request` 后：
- **不再**发该 `toolCallId` 的后续事件，直到 `respondPermission`
- `allowOnce`/`allowSession` → 继续 `tool_start`/`tool_update`/`tool_end`
- `deny` → `tool_end { isError: true }`，run 可继续至 idle
- 对已答复的 id 再 respond → reject `PERMISSION_EXPIRED`

### M5 — abort
`running` 中 `abort()` → 停止后续 token/工具事件 → `run_state: idle`；再 `prompt` 可从 idle 正常 `started`。

### M6 — 真 PTY 语义（mock 可伪造字节流，但命令面必须完整）
```
terminalCreate → ack{terminalId}
→ (mock 可选 echo: pty_output "PS1 提示")
terminalInput("echo hi\n") → pty_output 含回显/输出
terminalResize → 无事件，成功即可
terminalKill → pty_exit
再 terminalInput → reject TERMINAL_NOT_FOUND
非法 sessionId terminalCreate → reject SESSION_NOT_FOUND
```

**确定性要求：** 无网络；id 单调；延迟固定区间即可；`seq` 每 session 从 0 连续。

---

## 5. 错误策略（全契约唯一）

- **命令：** 一律 `Promise.reject(ContractError { code, message, details? })`，不用 null/字符串。
- **事件内错误：** 仅 `type:'error'` 变体，带同一套 `ContractErrorCode`。
- 禁止第三种形态（throw 裸 Error 字符串、resolve 错误对象等）。

---

## 6. 前端轨迁移清单（从现有代码 → 契约）

| 现状 | 目标 |
|------|------|
| `api/contract.ts` 两方法 `listProjects/sendPrompt(AsyncGenerator)` | 删除/替换为 `shared/contract` 的 `CodexApi` |
| `api/mock.ts` 假项目树 + per-request generator | 按 §4 重写为 session 订阅式 mock |
| `types/index.ts` 本地 `StreamEvent/DiffFile/Project` | 从 `shared/contract` re-export 或删除，禁止双源 |
| `DiffFile {path,patch}` vs mock `DiffLine[]` 漂移 | 统一为 `FileChange.patch` 字符串；`DiffPanel` 不动 |
| `useChat` 无 sessionId / 无 abort / 无 permission | 订阅 `subscribe(sessionId)`；加 Stop、权限 UI、`file_changes` |
| `TerminalDrawer` 假输入行 mock | 接 `terminalCreate/Input/Resize/Kill` + `pty_output/pty_exit`（xterm 级 UI 可后置，v1 可用行缓冲） |
| `App.handleSend` 空 | 接 `useChat`；侧栏 `listSessions/createSession/openSession` |
| `ChatView` 的 `::tool::`/`::error::` 文本标记 | 过渡期可保留；工具/错误应逐步改吃 `tool_*` / `error` 事件 |

**验收（并入原 Unit 7）：** M1–M6 六条路径在 `npm run dev` 下可人工走通；`tsc --noEmit` 双 config 通过。

---

## 7. 内核轨备忘（我方后续实现）

1. `src/shared/contract` 已入 tsconfig（node + web）。
2. preload：`ipcRenderer.invoke(IPC.*, …)` + `on(IPC.kernelEvent)` 包装成 `CodexApi`。
3. worker：`createAgentSession({ cwd })`；`session.subscribe` → 映射表（§3.2）→ `seq` 赋值 → 转发 main → renderer。
4. `beforeToolCall`：返回 blocking promise，桥到 `permission_request` / `respondPermission`。
5. `file_changes`：在 `afterToolCall` 或 tool_end 后从 edit 类结果聚合 unified diff。
6. 依赖：`@earendil-works/pi-coding-agent`（Node ≥ 22.19）。
7. **PTY（main 独占）：** `node-pty` + `@types/node-pty` 进 dependencies；`electron-rebuild`/`electron-builder` 配置原生模块；main 内 `TerminalManager`（按 sessionId 分组、seq 与 agent 事件合流到同一 `subscribe` 管道）；`electron.vite.config.ts` 将 `node-pty` 标为 `external`。安全注意：完整 shell，无 agent 门——文档已声明为有意行为。

---

## 8. 版本

| 版本 | 日期 | 变更 |
|------|------|------|
| v1 | 2026-09-23 | 初版冻结候选：命令 6、事件 10、IPC 通道 7 |
| v1.1 | 2026-09-23 | Terminal 改为**真 PTY（node-pty @ main）**：+4 命令、+2 事件（`pty_output`/`pty_exit`）、+2 错误码、+4 IPC 通道；废除「工具时间线」方案；Mock 增 M6 |
| v1.2 | 2026-09-23 | +1 命令 `applyFileChanges`、+1 IPC 通道；Diff Accept 实装（幂等写盘、`SESSION_BUSY` while running）；Reject = UI-only 不回滚 |
| v1.3 | 2026-09-24 | +4 命令 `listModels`/`getModelConfig`/`setModel`/`setThinkingLevel`、+1 UI 工具 `pickDirectory`、+5 IPC 通道、+类型 `ThinkingLevel`/`ModelOption`/`ModelConfig`；模型 chip 与 Choose project 原生目录选择器（见 backend-handoff §7.5C）；Plan/Ask·技能·连接器 **不在本版** |
