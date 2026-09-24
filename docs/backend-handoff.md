# 后端会话对接协议（renderer ↔ main ↔ worker）

**读者：** 后端 / 内核轨会话（实现或验收真链路时先读本文）；**前端轨对齐状态也先读本文**。  
**前端轨：** 已按 mock 验收 M1–M6 + `npm run typecheck` 双绿；UI 只依赖 `CodexApi` / `KernelEvent`。  
**权威类型与语义：** [`src/shared/contract/index.ts`](../src/shared/contract/index.ts) + [`docs/contract.md`](./contract.md)。本文不复制类型表；与二者冲突时以它们为准。  
**验收报告：** [`docs/acceptance-report.md`](./acceptance-report.md)（内核轨 §5 全量结果 + 复现命令）。

---

## 0. 对齐状态快照（2026-09-23 · 内核轨 · 2026-09-24 迁移后复核）

| 项 | 状态 | 证据 / 备注 |
|----|------|-------------|
| **项目根** | ✅ **`D:\2026\FlexAgent`** | 2026-09-24 自 `D:\2026\2026\codex-clone` 迁移；package name **`flex-agent`** |
| **git** | ✅ 首提交 `c4db5fc` | `Initial import: FlexAgent (migrated from codex-clone)` |
| 契约 | **v1.3 只增已落地**（model/thinking + `pickDirectory`） | `listModels`/`getModelConfig`/`setModel`/`setThinkingLevel` + IPC；contract.md §2/§8 已同步 |
| typecheck | ✅ 双 tsconfig exit 0 | `npm run typecheck`（迁移后复跑 exit 0） |
| 真链路桥 | ✅ | CDP page title=`FlexAgent`；`window.electron.codex.prompt` 为 function |
| M1–M5 smoke | ⚠️ **M1/M5/M4/M2 绿；M3 依赖模型速度** | 2026-09-24 串行存档：仅 M3 150s 未 idle（`queuedHit` 协议正确）；`diag-m3` 独立 112s PASS；非 v1.3 回归（拍板：不改脚本） |
| M6 真 PTY | ✅ **迁移后复跑 PASS；v1.3 后串行复跑** | `scripts/accept-m6.mjs` → `ACCEPT_M6_PASS` 7/7（echo `M6_ECHO_OK` · cwd=`D:\2026\FlexAgent`） |
| mock fallback | ✅ **迁移后全绿；v1.3 后串行复跑** | `scripts/accept-mock-fallback.mjs` → `MOCK_FALLBACK_PASS` |
| §7.2.2 断连语义 | ✅ 内核已实现 | worker 死 → `error`+`idle` fanOut → `seq.clear` → 自动重启；`openSession` 幂等保持 |
| §7.3 断连走查 | ✅ **迁移后双 PASS；v1.3 后串行复跑** | 内核 `ACCEPT_DISCONNECT_PASS`（8/8）· UI `ACCEPT_DISCONNECT_UI_PASS`（6/6） |
| `applyFileChanges` | ✅ 契约 v1.2 已只增 | main 独占 `src/main/applyChanges.ts`；preload/ipc 已接 |
| **模型/思考 + pickDirectory** | ✅ **契约 v1.3 已只增 + CDP 冒烟 PASS**（2026-09-24） | worker `ModelRuntime` + `session.setModel/setThinkingLevel`；ipc/preload 已接；`scripts/accept-model.mjs` → `ACCEPT_MODEL_PASS` **11/11**；见 §7.5C |
| **插件系统** | 🟡 **契约 v1.4 设计就绪（待实现）** | 见 §7.6；后端 [`plugin-backend.md`](./plugin-backend.md)、前端 [`plugin-frontend.md`](./plugin-frontend.md)、设计 [`plugin-design.md`](./plugin-design.md) |
| `listFiles` / `rename` / `archive` | ⏸️ 按 §7.1 现不做 | 前端 localStorage 覆盖层 / fixture |

### 0.0.1 仓库迁移（2026-09-24）

- **旧根：** `D:\2026\2026\codex-clone`（**保留未删**，归档待拍板）
- **新根：** `D:\2026\FlexAgent`；**应用名 FlexAgent**；`package.json` `name: flex-agent`
- **改动范围：** 路径硬编码（`scripts/*.mjs` CWD、docs 引用、renderer 内路径字面量）+ 品牌字符串；**契约语义 / `CodexApi` 类型名未动**
- **git：** `c4db5fc`（64 files）；`.gitignore`：`node_modules/` `out/` `dist/` `*.log` `.tmp-*/` `*.png` 等
- **迁移后全绿（本机复跑）：** typecheck 0 · pong · **smoke PASS** · **mock-fallback PASS** · **disconnect 8/8** · **disconnect-ui 6/6** · **M6 PASS 7/7**
- **apply：** ✅ **新根复跑 `ACCEPT_APPLY_PASS`（11/11，exit 0）**

**给前端的一句话：** 项目根已迁 **`D:\2026\FlexAgent`**。契约 **v1.3 只增**已落地且 **`ACCEPT_MODEL_PASS` 11/11**；typecheck / mock / 断连 / M6 / apply / model **全绿，可开工**。smoke M2/M3 依赖模型速度（`qwen-chat` 长回复可能超 150s），**非回归、验收阈值不改**。§7.3 已关闭。你的待办：① **§7.5C 接线** — Choose project→`pickDirectory`→`createSession`；模型 chip→`listModels`/`setModel`/`setThinkingLevel`（label 用返回 `ModelConfig`）；+ 菜单先做壳；② assistant 气泡 **markdown 渲染**；③ **§7.5 终端 xterm + Composer 死按钮**（你侧 TerminalDrawer 已换 xterm，按 §7.5A 收尾）。

### 0.1.5 断连走查（§7.3）— 已关闭（双侧）

1. 内核：`node scripts/accept-disconnect.mjs` → `ACCEPT_DISCONNECT_PASS`（8 checks）。  
2. UI：`node scripts/accept-disconnect-ui.mjs` → `ACCEPT_DISCONNECT_UI_PASS`（6 checks）。  
3. **test-only** 钩子 `window.electron.diag.killWorker()`——**非** `CodexApi`，产品代码勿依赖。  
4. 前端本轮修复：`useChat` `case 'error'` + `KERNEL_INTERNAL` → 立即 `applyDegraded()` 并自动 `openSession`（原先只 push error-block，无后续事件则 banner 永不出现）。

### 0.1 前端现在可以依赖的真链路事实

1. **自动切换：** `window.electron?.codex` 存在即真链路，无则 mock——UI 不用改开关。  
2. **`prompt` 只等接受：** resolve = `PromptAck`（`started` / `steering` / `queued`），**不等** run 结束；run 结束看 `run_state: idle`。  
3. **权限门：** `permission_request` 后该 `toolCallId` **零** tool 事件直到 `respondPermission`；`deny` → `tool_end.isError: true`，run 可继续到 idle。  
4. **followUp（PI 语义）：** 同一 agent run 内 drain，**不会**出现中间 `idle→running` 第二条边；断言用「followUp 的 `user_message` 在最终 idle 前」。  
5. **seq：** 每 session 从 0 连续；`pty_*` 与 agent 事件**共享**同一 seq 流；缺口 → 不可靠 → 重新 `openSession`。  
6. **错误：** 只 `ContractError`（`{code,message,details}` 过 contextBridge 已保真为 plain object reject）；未知内部失败 = `KERNEL_INTERNAL`。  
7. **PTY：** 真 ConPTY；`terminalKill` 后必有 `pty_exit`；再 input → `TERMINAL_NOT_FOUND`；4/session → `TERMINAL_LIMIT`。resize 后可能重绘 `pty_output`（协议层仍全是 `pty_*`）。  
8. **断连（7.2.2）：** worker 非正常退出 → 已知 session 收 `type:'error'`（running 先补 `idle`）→ `seq` 从 0 重开 → 自动重启 worker；UI 应用 seq 缺口 + `openSession` 对账，**勿**静默半死。

### 0.2 内核轨验收复现（前端可抽查）

```powershell
npm run typecheck
npm run dev -- -- --remote-debugging-port=9222
node scripts/accept-smoke.mjs        # 期望 ACCEPT_SMOKE_PASS（LLM 偶发慢，超时已放宽）
node scripts/accept-m6.mjs           # 期望 ACCEPT_M6_PASS
node scripts/accept-mock-fallback.mjs # 期望 MOCK_FALLBACK_PASS
node scripts/accept-disconnect.mjs   # 期望 ACCEPT_DISCONNECT_PASS（§7.3 内核）
node scripts/accept-disconnect-ui.mjs # 期望 ACCEPT_DISCONNECT_UI_PASS（§7.3 UI；串行）
node scripts/accept-model.mjs        # 期望 ACCEPT_MODEL_PASS（契约 v1.3；串行）
# smoke：M2/M3 对 qwen-chat 可能 >150s；独立 diag-m3 可 112s PASS——按速度备注，非失败判据
```

细节与修复清单：[`docs/acceptance-report.md`](./acceptance-report.md)。

---

## 1. 缝（seam）

```
Renderer                    Preload                 Main                      Worker
codexApi: CodexApi    ←→    contextBridge          IPC.* handlers        ←→   WorkerRequest / PI
subscribe(KernelEvent) ←──  ipcRenderer.on  ←────  KernelHost.fanOut     ←──  postMessage(event)
```

- **唯一跨轨接口：** `CodexApi`（命令）+ `KernelEvent`（事件判别联合）。
- **可丢弃：** mock、IPC 通道名实现细节、`kernel-protocol.ts` 的 worker 信封。
- **禁止外泄：** PI 类型、`WorkerRequest`/`WorkerResponse`、`StripSeq` 等 main↔worker 形状不得进入 renderer 或 `shared/contract`。

**切换开关（已落地）：** [`src/renderer/src/api/index.ts`](../src/renderer/src/api/index.ts)

```ts
window.electron?.codex ? window.electron.codex : new MockCodexApi()
```

preload 暴露 `electron.codex` 后，renderer **自动**走真链路；无需改 UI。

---

## 2. 磁盘上已有什么（勿重写）

| 层 | 路径 | 状态 |
|----|------|------|
| 契约 | `src/shared/contract/index.ts` | **v1.2 冻结候选**；只增不改（含 `applyFileChanges`） |
| 契约说明 | `docs/contract.md` | §2–§5 命令/事件/错误；§4 = 前端验收 M1–M6 |
| worker 协议 | `src/shared/kernel-protocol.ts` | main↔worker 内部；**非** UI 契约 |
| preload | `src/preload/index.ts` | 完整 `CodexApi` 桥 + 错误 plain-object reject（contextBridge 保真）；**另有 test-only** `electron.diag.killWorker`（§7.3，勿依赖） |
| IPC | `src/main/ipc.ts` | 全部 `IPC.*` handler + `ContractError` → `{code,message,details}` |
| 内核宿主 | `src/main/kernel.ts` | worker 生命周期、`request` 关联、**`seq` 赋值**、`fanOut`、**§7.2.2 断连恢复** |
| 会话注册表 | `src/main/registry.ts` | `userData/sessions.json`；`runState` 与 `setRunState` 同步 |
| Diff Accept | `src/main/applyChanges.ts` | `applyFileChanges`：路径 containment + 幂等写盘（main 独占 fs） |
| PTY | `src/main/pty.ts` | 真 node-pty（ABI 149 已 rebuild）；上限 4/session；`pty_*` 同 `fanOut`；kill 失败补发 `pty_exit` |
| 入口 | `src/main/index.ts` | 组装上述组件 |
| PI worker | `src/main/worker.ts` | PI 事件 → `WorkerKernelEvent`（无 `seq`）；权限门；`file_changes` 聚合 |
| UI | `src/renderer/**` | 已按契约消费；mock 为 fallback |

**后端会话默认任务：** 在不改 `shared/contract` 语义的前提下，让真链路跑通 §4 等价路径；缺口只修 main/worker/preload（及必要的 `kernel-protocol`），不改 UI 消费方式。

---

## 3. 后端必须守住的不变量

### 3.1 命令（renderer → 你）

见 contract.md §2。补充实现向约束：

1. **`prompt` 在被接受时 resolve**（`PromptAck`），不等 run 结束。
2. **`disposition` 表**（contract §2.1）：`idle → started`；`running` + 省略/`steer` → `steering`；`running` + `followUp` → `queued`。  
   今日 main 在 `ipc.ts` 里按 `registry.runState` 预判，worker 以 `session.isStreaming` 复核——两边必须一致，以 worker 返回的 `ack.disposition` 为准回传 UI。
3. **`respondPermission`：** 未知或已结算的 `toolCallId` → reject `PERMISSION_EXPIRED`（worker `pending` map）。
4. **错误形态唯一：** `Promise.reject` 携带可序列化 `{ code, message, details? }`；preload 还原成 `ContractError`。禁止 null/裸字符串/resolve 错误对象（contract §5）。

### 3.2 事件（你 → renderer）

1. **`seq` 只在 main 赋值：** `KernelHost.fanOut` 每 session 从 0 单调 +1；worker 只发 `WorkerKernelEvent`（无 `seq`）。缺口 = 丢事件。
2. **`sessionId` + `ts`：** `fanOut` 统一盖章；`pty_*` 与 agent 事件**共享同一 session 的 seq 流**。
3. **`run_state`：** 仅 `idle↔running` 跳变；`agent_settled` 是 idle 的唯一来源（contract §3.2）；abort 结束后必须落到 idle。
4. **`permission_request` 后：** 该 `toolCallId` 零后续 tool 事件，直到 `respondPermission`；`deny` → `tool_end.isError: true`，run 可继续。
5. **`file_changes`：** 快照替换（非增量）；`path` 相对 session `cwd`、POSIX；`patch` 为 unified diff 文本。
6. **`message_end`：** 权威正文；UI 按 `message.id` 替换 partial。
7. **`user_message`：** 直接 prompt、steer 生效、followUp **实际执行** 时各发一次（不是 enqueue 时）。

### 3.3 PTY（main 独占）

- 不经 agent 权限门（有意为之，contract §2/§3.3）。
- `terminalKill` 对已死 id 幂等成功；未创建 id → `TERMINAL_NOT_FOUND`。
- 每 session 存活上限 4 → `TERMINAL_LIMIT`。

### 3.4 演进

- **只增不改：** 新事件变体、可选字段；不重命名、不复用旧字段语义。
- 改契约 → 同步 `docs/contract.md` 版本表，并在对接会话里声明（前端只认 contract，不认口头约定）。

---

## 4. 前端已按 mock 验收的行为（真链路需行为等价）

来源：contract.md §4。验收命令：`npm run dev` 下人工/Playwright 走通 + `npm run typecheck`。

| ID | 路径 | 前端观察点 | 内核真链路 |
|----|------|-----------|------------|
| M1 | idle prompt → 流式 → `file_changes` → idle | 工具卡、正文、Diff 自动开、无 `::` 标记 | ✅ |
| M2 | running 中 steer | `ack{steering}`；中途新 `user_message`；不中断 | ✅ |
| M3 | running 中 followUp | `ack{queued}`；idle 前出现该消息；再跑一轮 | ✅（PI 同 run drain，无中间 idle→running） |
| M4 | 首次敏感工具权限 | 模态；allow → 继续；deny → tool error，run 到 idle | ✅ |
| M5 | abort | 停后续事件 → idle；再 prompt → `started` | ✅ |
| M6 | PTY | create → 输出；input 回显；kill → `pty_exit`；再 input → `TERMINAL_NOT_FOUND` | ✅ `ACCEPT_M6_PASS` |

**Mock 对照实现：** `src/renderer/src/api/mock.ts`（fixture 可丢弃；**事件顺序语义**是对照标准）。

---

## 5. 对接验收（后端完成后双方各跑一遍）

1. `npm run typecheck` → 两个 tsconfig 均 exit 0。  
2. `npm run dev` → renderer 走 `window.electron.codex`（DevTools 里 `typeof window.electron?.codex.prompt === 'function'`）。  
3. 走通 §4 的 M1–M6（可用前端已有的 Playwright 脚本思路：header「Running」、`[data-testid=permission-dialog]`、`[data-testid=terminal-drawer]`、Review `role=dialog`）。  
4. 断言：无 `::tool::` / `::error::`；事件 `seq` 同 session 从 0 连续；`ContractErrorCode` 仅出现在契约枚举内。  
5. 回归：关 mock 不必删——`window.electron` 缺失时仍应 fallback 到 mock（本地无 PI 依赖时前端可继续开发）。

**完成判据：** 上述 1–4 全绿；M1–M6 与 mock 走查结果一致（允许文案/延迟差异，不允许事件缺失或顺序违反 §3.1–§3.2）。

**内核轨完成情况（2026-09-23）：** 1–5 **全绿**（含 M6 与 mock fallback）；报告见 [`docs/acceptance-report.md`](./acceptance-report.md)。§7.3 断连人工走查仍待前端在 UI 上确认。

---

## 6. 改动边界

| 谁 | 可改 | 不可改 |
|----|------|--------|
| 后端会话 | `src/main/**`、`src/preload/**`、`src/shared/kernel-protocol.ts`、`package.json` 原生依赖 | `shared/contract` 语义；`renderer` 消费方式；UI 组件 |
| 前端会话 | `src/renderer/**` | 后端实现文件；契约已有字段语义 |
| 双方 | `docs/contract.md` + 契约**新增** | 已发布字段重命名/复用 |

**报错对接：** 后端 reject 的 `code` 必须是 `ContractErrorCode` 之一；未知内部失败用 `KERNEL_INTERNAL`，细节放 `details`。

**事件对接一句话：** worker 无 `seq` → main `fanOut` 盖 `seq`/`sessionId`/`ts` → preload 按 session 过滤 → UI `subscribe`。任何一层丢顺序或改语义，前端视为契约破坏。

---

## 7. 前端演进中 · 后端需知（滚动更新）

前端在 mock 前提下继续扩展 UI。下列各项对**现有 §2/§3 契约的依赖关系**已标明——**未标「需新命令」的，真链路无需为它做任何事**。

### 7.1 已规划/进行中的前端能力

| # | 能力 | 契约依赖 | 后端动作 |
|---|------|----------|----------|
| 1 | 命令面板（Ctrl+K：新聊天 / 切会话 / 设置入口） | 仅 `listSessions` + `createSession` + `openSession` | **无**（纯 UI 编排） |
| 2 | Composer `@` 文件联想 | **需新命令（后续）**：按前缀列 session `cwd` 下文件，建议 `listFiles({ sessionId, query? }) → { path: string[] }`（路径相对 cwd、POSIX，与 `FileChange.path` 一致） | **现在不做**；mock 阶段前端自造 fixture。真要做真联想时再**只增**该命令并升 contract 版本表 |
| 3 | 消息复制 / 重新生成 | 复制=纯前端；**重新生成 = 再次 `prompt({ sessionId, text })`（idle 时 `started`）**，复用现有命令 | **无**；勿为 regenerate 发明并行 API |
| 4 | 会话重命名 / 归档 / 搜索 | **需新命令（可选）**：`renameSession` / `archiveSession`；搜索可前端过滤 | **现在不做**。前端先 **localStorage 覆盖层**（只改展示 title，不改 `sessionId`）。若后端将来提供 rename，以你们的持久化为准，前端覆盖层应可被 `listSessions` 结果覆盖掉 |
| 5 | ErrorBoundary + 断连/重连态 | 依赖 §3「seq 缺口 = 不可靠 → 重新 `openSession` 对账」；**无新事件** | **守住：** ① subscribe 在 main 崩溃/重启后不得静默半死——要么通道报错让 UI 进断连态，要么新连接从 seq 0 重新 fanOut；② `openSession` 幂等（已写）必须保持，供前端重连对账；③ 错误仍只走 `ContractError` / `type:'error'` |
| 6 | 加载骨架屏 | 无 | **无** |
| 7 | 快捷键统一 | 无 | **无** |
| 8 | Diff 深色区 / 终端配色 / 暗色预留 | 无（`patch` 仍是 unified diff 文本） | **无** |
| 9 | Diff Accept 实装（`applyFileChanges`） | **需新命令（v1.2 已只增）**：`applyFileChanges({ sessionId, files }) → { applied, alreadyApplied, failed[] }`；IPC `codex:applyFileChanges` | **main 独占**：`registry.require` 取 cwd → 路径 containment（禁 `..`/绝对路径逃逸）→ `diff.applyPatch` 写盘；runState `running` → `SESSION_BUSY`；幂等（已是目标内容 → `alreadyApplied`）。**不进** worker/kernel-protocol/transcript。Reject = 前端关面板，**无**后端动作、**不做**磁盘回滚 |

### 7.2 给后端会话的明确请求（按优先级）· 内核轨回执

| # | 前端请求 | 内核轨状态（2026-09-23） |
|---|----------|--------------------------|
| 1 | 不为 regenerate/面板/骨架/快捷键加事件 | ✅ 未加；仍用现有 `prompt` / 会话命令 |
| 2 | seq / 重连语义（#5） | ✅ **7.2.2 已实现**：`error`+`idle` fanOut → `seq.clear` → 自动重启；`openSession` 幂等 |
| 3 | 暂不实现 `listFiles` / `rename` / `archive` | ✅ 未实现；等 UI 需要真数据再走 §3.4 只增 |
| 4 | 前端只改 `renderer/**`；契约变更先记 §7 | ✅ 内核未动 renderer；契约只增（v1.2） |
| 5 | 契约 v1.2 `applyFileChanges` | ✅ **已落地**：`applyChanges.ts` + ipc + preload；`scripts/accept-apply.mjs` 可跑 |

### 7.3 验收口径补充 — **已关闭（双侧 2026-09-23）**

- M1–M6 + typecheck 口径不变（§4/§5）；内核轨 §5 已全绿（见 §0 / acceptance-report）。  
- 断连态（#5）**双侧 PASS，关闭：**  
  - 内核：`accept-disconnect.mjs` → `ACCEPT_DISCONNECT_PASS`（8/8）。  
  - UI：`accept-disconnect-ui.mjs` → `ACCEPT_DISCONNECT_UI_PASS`（6/6）；banner lost→reconciling→reconnected，error-block 清除，无 ErrorBoundary 崩溃。  
  - 钩子：`electron.diag.killWorker`（**非** CodexApi；仅验收）。  
- 验收脚本并行会踩 `window.__m6` / `__acc2` / `__disc` 等全局——**串行跑**。

### 7.4 内核轨已知环境注意（非契约）

- LLM（qwen-chat）偶发慢/空回；`ack` 始终 ms 级、不依赖 LLM。smoke settle 超时已放宽。  
- 真 PTY resize 后 ConPTY 可能重绘 shell（多条 `pty_output`）；断言「成功即可 / 无非 `pty_*` 协议事件」。  
- M6/错误码曾因 `Object.assign` 盖 message、Error 过 contextBridge 丢 code 而全变 `KERNEL_INTERNAL`——已修；前端若见裸 `KERNEL_INTERNAL` 且无 details，属异常，报内核轨。

### 7.5 前端轨待修（内核轨只读诊断 · 2026-09-24）

用户报了两处 UI 问题。内核轨读了 `src/renderer/**` 做根因定位，**未改任何 renderer 文件**（§6 边界）。前端轨按此修。

#### A. 终端抽屉 ANSI 乱码

| 层 | 结论 |
|----|------|
| 内核 | ✅ 正确。`pty.ts` `onData` 原样 `fanOut` ConPTY 字节流；契约 §4 = `pty_output` append 字节流。`accept-m6` 7/7（新根复跑），样例数据本身含 `ESC[K` / `ESC[?25h` 等转义——**这是正常 PTY 输出**。 |
| 前端 | ❌ `TerminalDrawer.tsx:92` 把 `event.data` 当纯文本 `setBuffer(prev => prev + event.data)`；`:205` 渲染 `{buffer}` 到 `<div>`。**无终端模拟器** → ANSI 被原样显示成乱码。 |

**修法（前端轨）：**
1. 引入 `@xterm/xterm`（+ `@xterm/addon-fit`）。`package.json` 当前**无** xterm 依赖。
2. `pty_output` → `term.write(event.data)`；`pty_exit` → 标记 dead。
3. ResizeObserver → `fitAddon.fit()` → 再 `terminalResize({ terminalId, cols, rows })`。
4. `terminalInput`：`onData` 键盘流写回（或保留现输入行，但 xterm 自带输入更正确）。
5. 降级方案（可先上）：`strip-ansi` / `ansi-to-html` 清转义——仅止乱码，**不是**真终端（无光标/清屏/颜色）。

**勿改：** 内核不要 strip 后再发——真终端需要原始字节流（契约 §4）。

#### B. Composer 部分按钮点击无响应

`Composer.tsx` 读码（行号基于当前文件）：

| 控件 | 有无 handler | 说明 |
|------|-------------|------|
| Choose project（L402–410） | ❌ **无 `onClick`** | 纯展示 stub，点了没反应 = 预期（未实装） |
| `+` 附件（L431–438） | ❌ **无 `onClick`** | 同上 |
| 模型选择 chip（L471–474） | ❌ **无 `onClick`** | 同上 |
| Manual/Auto/Full access | ✅ `cycleApproval`（L443） | 应可切换文案 |
| 发送 ↑（L476–491） | ✅ `submit` | 需 `text.trim()` 非空且 `!disabled` |
| Queue（running 时） | ✅ | 仅 `running &&` 渲染 |

**全局 disabled 源：** `App.tsx:259` → `disabled={!activeSessionId}`。无选中会话时 **整个 composer disabled**，Manual/发送也会变灰（`disabled:opacity-40`）。

**用户症状 → 根因：**
- Choose project / `+` / 模型 chip 点不动 → **从未接线**（前端决策：v1 做不做这些入口）。
- 若 Manual、发送在**有会话**时也无反应 → 查 `activeSessionId` 是否为 null；有会话仍无反应 → 查 HMR/React 事件被 overlay 截获（z-index），再报内核轨。
- 截图里手动输入了文本，发送按钮若灰 → `disabled` prop 为 true（无 session）优先查这个。

**修法建议（前端轨，按优先级）：**
1. 有 session 时 Manual/发送必须可点——验证 `activeSessionId` 传入。
2. Choose project / `+` / 模型 chip：实装或先 `disabled` + tooltip「Not yet」，避免死按钮观感。
3. 模型 chip 文案 `mimo-v2.6 Flash` 与后端模型解耦（展示用 UI 配置即可，**无需**新契约命令）。

**契约影响：** **无。** 两问题均纯 renderer；内核/契约零动作。

**验收（前端修完）：**
- 终端：开抽屉 → 看到 cmd 提示符而非 `@[K`；`echo hi` 回显正常；resize 后不断行。
- Composer：有 session → Manual 可循环、有文本时 ↑ 可发送；无 session → composer 整体灰且不响应（符合 `disabled`）。

#### C. 产品意图 vs 当前差距（2026-09-24 · 契约 v1.3 开工）

用户确认的三项产品意图，对照现契约与内核能力：

| 入口 | 产品意图 | v1.2 现状 | 差距 | 分轨动作 |
|------|----------|-----------|------|----------|
| **Choose project** | 选会话工作区（= `createSession` 的 `cwd`；切换项目 = 新会话） | 契约已有 `CreateSessionInput.cwd`；UI 硬编码 `WORKSPACE_CWD` | 缺**原生目录选择器** | **内核：** `pickDirectory()`（Electron dialog，`openDirectory`）→ 返回 `string \| null`。**前端：** 点击 → `pickDirectory` → `createSession({ cwd })` / 展示 basename |
| **模型 chip** | 切换可用模型 + **思考强度** | 契约/`CodexApi` **无**任何 model/thinking 命令；worker `createAgentSession({cwd,sessionManager})` 未暴露 PI 运行时切换 | **整块缺失** | **内核（v1.3 只增）：** `listModels` / `getModelConfig` / `setModel` / `setThinkingLevel` + IPC。PI：`ModelRuntime.getAvailable()`、`session.setModel(model,{persist:false})`、`session.setThinkingLevel(level)`、`session.model`/`thinkingLevel`/`getAvailableThinkingLevels()`。**前端：** chip 打开菜单（模型列表 + 思考档）→ 调上述命令 → 用返回值刷新 label |
| **+ 菜单** | Codex 式：添加文件 / 模式 Plan·Ask / 技能 / 连接器（见用户截图） | 无入口；`PromptMode`（steer/followUp）**≠** Plan/Ask agent 模式 | 菜单壳 + 若干子能力 | **前端：** 菜单 UI 可先落地。子项：① **附件** → v1.3 **只增** `PromptInput.attachments?: Array<{ path, kind: 'file' }>`（文本内联路径，无 `listFiles`）或纯前端把路径拼进 `text`（零契约）；② **Plan/Ask** → **本轮不做**（需 PI plan-mode/扩展，契约另开只增）；③ 技能/连接器 → **本轮不做**（等 PI skill API 接入） |

**契约影响（v1.3 只增，不改已有语义）：**

```ts
type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
interface ModelOption { provider: string; id: string; label?: string }
interface ModelConfig {
  model: ModelOption | null
  thinkingLevel: ThinkingLevel
  availableThinkingLevels?: ThinkingLevel[]
}
// CodexApi 追加：
listModels(): Promise<ModelOption[]>                    // 可用模型（有鉴权）
getModelConfig(sessionId): Promise<ModelConfig>        // 当前会话生效配置
setModel({ sessionId, provider, id, thinkingLevel? }): Promise<ModelConfig>
setThinkingLevel({ sessionId, level }): Promise<ModelConfig>
pickDirectory(): Promise<string | null>                 // 取消 → null
// IPC 追加：codex:listModels | getModelConfig | setModel | setThinkingLevel | pickDirectory
```

- 运行时语义：`persist: false`（**仅本会话**，不写 PI 全局 default）；`setModel` 后 `thinkingLevel` 由 PI 按模型能力 clamp，返回值以 **实际生效** 的 `ModelConfig` 为准。
- `listModels` 不依赖 active session（worker 缓存一个 `ModelRuntime`）；`get/set*` 需要已 `createSession`/`openSession` 的 session。
- **Plan/Ask、技能、连接器：** 明确 **v1.3 不做**；前端菜单可先 disabled + tooltip。
- **Mock：** `MockCodexApi` 同步实现上述方法（fixture 模型列表 + 会话内内存配置），保证 `typecheck` 双绿；真数据以 `window.electron.codex` 为准。

**给前端的一句话（§7.5C）：** 契约升 **v1.3** 后，Choose project 接 `pickDirectory`→`createSession`；模型 chip 接 `listModels`/`setModel`/`setThinkingLevel`（label 用返回的 `ModelConfig`）；+ 菜单可先做壳（附件可文本内联，Plan/Ask/技能/连接器 disabled）。详见 `docs/contract.md` §2 / §8。

### 7.6 插件系统（v1.4 · 2026-09-24）

侧栏 `Plugins` 死按钮接入插件管理（P1：extensions + skills 本地插件管理闭环）。

- **权威设计：** [`docs/plugin-design.md`](./plugin-design.md)
- **后端实现计划（内核轨）：** [`docs/plugin-backend.md`](./plugin-backend.md)
- **前端实现计划（前端轨）：** [`docs/plugin-frontend.md`](./plugin-frontend.md)
- **契约：** v1.3 → **v1.4**（+5 命令 `listPlugins`/`getPlugin`/`setPluginEnabled`/`installPlugin`/`uninstallPlugin`、+全局订阅 `subscribePlugins`、+6 IPC 通道、+5 `PLUGIN_*` 错误码、+插件类型；见 contract.md §2.3/§8）。
- **架构要点：** zcode 风格声明式 manifest（`plugin.json` + 目录布局）＋ **PI 稳定扩展机制**为唯一执行运行时（`worker.ts` 构造 `DefaultResourceLoader` → `createAgentSession({ resourceLoader })`，当前 worker 未传 resourceLoader）；启停走 **受控内核重启**（非 §7.2.2 非预期崩溃）。
- **⚠ 更正 §7.5C：** 原写"技能/连接器 → 等 PI skill API 接入"。**PI skill API 已就绪**（`DefaultResourceLoader` + `examples/sdk/04-skills.ts` + 导出 `loadSkills`/`loadSkillsFromDir`/`Skill`），故 **skills 纳入 P1**；连接器（MCP）仍留 P2。
- **`pluginsChanged` 不走 `KernelEvent`**（独立全局 IPC 通道 `codex:pluginsChanged`）——勿塞进 session `seq` 流。
