# 后端会话对接协议（renderer ↔ main ↔ worker）

**读者：** 后端 / 内核轨会话（实现或验收真链路时先读本文）；**前端轨对齐状态也先读本文**。  
**前端轨：** 已按 mock 验收 M1–M6 + `npm run typecheck` 双绿；UI 只依赖 `CodexApi` / `KernelEvent`。  
**权威类型与语义：** [`src/shared/contract/index.ts`](../src/shared/contract/index.ts) + [`docs/contract.md`](./contract.md)。本文不复制类型表；与二者冲突时以它们为准。  
**验收报告：** [`docs/acceptance-report.md`](./acceptance-report.md)（内核轨 §5 全量结果 + 复现命令）。

---

## 0. 对齐状态快照（2026-09-23 · 内核轨）

| 项 | 状态 | 证据 / 备注 |
|----|------|-------------|
| 契约 | **v1.2 冻结候选**（只增不改） | `applyFileChanges` + IPC + contract.md §2 已双表同步 |
| typecheck | ✅ 双 tsconfig exit 0 | `npm run typecheck` |
| 真链路桥 | ✅ | `window.electron.codex.prompt` 为 function |
| M1–M5 smoke | ✅ 曾全绿 | `scripts/accept-smoke.mjs` → `ACCEPT_SMOKE_PASS` |
| M6 真 PTY | ✅ PASS（独立复核） | `scripts/accept-m6.mjs` → `ACCEPT_M6_PASS` 7/7 |
| mock fallback | ✅ | `scripts/accept-mock-fallback.mjs` → `MOCK_FALLBACK_PASS` |
| §7.2.2 断连语义 | ✅ 内核已实现 | worker 死 → `error`+`idle` fanOut → `seq.clear` → 自动重启；`openSession` 幂等保持 |
| §7.3 断连走查 | ✅ **内核 + UI 双 PASS** | 内核 `ACCEPT_DISCONNECT_PASS`（8/8）· UI `ACCEPT_DISCONNECT_UI_PASS`（6/6） |
| `applyFileChanges` | ✅ 契约 v1.2 已只增 | main 独占 `src/main/applyChanges.ts`；preload/ipc 已接 |
| `listFiles` / `rename` / `archive` | ⏸️ 按 §7.1 现不做 | 前端 localStorage 覆盖层 / fixture |

**给前端的一句话：** 契约 v1.2 + M1–M6 真链路 + apply + §7.3 断连走查（内核 8/8 · UI 6/6）**全绿，可联调**。§7.3 已关闭：kill 后 banner「Connection lost — reconciling…」→ error-block(`KERNEL_INTERNAL`) → ~3s「Reconnected」，无 ErrorBoundary 崩溃。

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
