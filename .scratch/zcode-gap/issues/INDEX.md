# ZCode 对照差距 —— 工单索引

来源：ZCode（zcode.z.ai / zai-org/ZCode）与本仓库的功能对照分析。  
用法：**每个执行会话领取一张工单**，只做该工单并在完成后勾掉验收项。

## 规则

- 一票一文件，按依赖序编号；`Blocked by` 全部完成才能领取（frontier）。
- 状态统一 `ready-for-agent`；完成后把状态改为 `done` 并勾选验收项。
- 工单内避免写死代码路径（会过期），以行为验收为准。

## 依赖总览

```
01 ─┬─ 02 ─┬─ 05 ─┬─ 06
    │      │      └─ 07
    │      ├─ 11
    │      └─ 13 ── 14 ── 22
    ├─ 03 ── 16
    ├─ 04 ─┐
    ├─ 08  │
    ├─ 09  ├─ 25 (02+04)
    ├─ 10  │
    ├─ 12 ─┴─ 17
    ├─ 15
    ├─ 18 ── 27
    ├─ 19 ── 28
    ├─ 20 ── 26
    ├─ 21
    ├─ 23
    └─ 24
```

> 26 / 27 / 28 是 2026-09-26 复核时从 20 / 18 / 19 拆出来的**后端与遗留部分**。  
> 拆票理由统一写在各自工单里，一句话版本：**不要让"done（部分）"把未闭环的真实状态藏起来**。

## 优先级与工单

### P0 地基（先做）

| 工单 | 标题                      | Blocked by |
| -- | ----------------------- | ---------- |
| 01 | 落库未提交子系统（git 卫生）        | —          |
| 02 | 工程工具链（lint + 单测 runner） | 01         |
| 03 | 多智能体端到端验证               | 01         |
| 04 | UI P0 修复                | 01         |

### P1 高价值功能

| 工单 | 标题         | Blocked by |
| -- | ---------- | ---------- |
| 05 | 目标模式核心     | 01, 02     |
| 06 | 目标模式 UI    | 05         |
| 07 | 计划模式 UX    | 05         |
| 08 | 推理强度切换     | 01         |
| 09 | 使用统计页      | 01         |
| 10 | 提问超时自动继续   | 01         |
| 11 | 图片附件       | 01, 02     |
| 12 | 会话重命名/归档后端 | 01         |

### P2 扩展性与生态

| 工单 | 标题                                        | Blocked by |
| -- | ----------------------------------------- | ---------- |
| 13 | Hooks①：PreToolUse veto + UserPromptSubmit | 01, 02     |
| 14 | Hooks②：Stop block + PermissionRequest     | 13         |
| 15 | Memory 自动提取管线                             | 01         |
| 16 | 自定义子智能体                                   | 03         |
| 17 | 会话分叉                                      | 01, 12     |
| 18 | 上下文引用补全（@ / 划选 / #）                       | 01         |
| 19 | 权限确认粒度（始终允许作用域）                           | 01         |
| 27 | 上下文引用**后端**（引用字段 / listFiles / 读文件 / 读会话） | 18         |
| 28 | 「本会话始终允许」做成可撤销持久规则                        | 19         |

### P3 工程与安全

| 工单 | 标题                                | Blocked by |
| -- | --------------------------------- | ---------- |
| 20 | 凭据加密（MCP 配置，20a）                  | 01         |
| 26 | **模型 API key 加密**（20b，用户真正持有的那一份） | 20a        |
| 21 | IPC sender 校验 + CSP（安全 P2 快赢）     | 01         |
| 22 | 插件/hooks 沙箱（安全 P2 大件）             | 14         |
| 23 | MCP 补全（SSE + 插件配置面板）              | 01         |
| 24 | 插件市场补全（npx 源 + 管线观测）              | 01         |
| 25 | 打包分发（Windows 安装包）                 | 02, 04     |

## 当前 frontier（可立即领取）

- 无 —— **29** 于 2026-09-27 收口，**29/29 全部 done**
- 已完成：01、02、03、04、05、06、07、08、09、10、11、12、13、14、15、16、**17**、**18**、19、**20**、21、**22**、23、24、25、**26**、**27**、**28**、**29**
- 部分完成（有具名未闭环项）：无——2026-09-27 晚间把 04/05/06/11/16/25 的具名残留全部以真机证据闭环（见"认领"末条），06 与 11 的"部分"标注已撤
- 阻塞中：无（20 的 20b 已拆为 26 并单独落库）

## 认领

- **01** 已于 2026-09-26 落库完成（工作区由 76 条未跟踪收敛到 8 个提交）。
- **02 / 03 / 04 / 08** 已于 2026-09-26 由编排会话完成并分车道提交  
  （`766e3b1` 工具链 · `21fc0ed`+`777b3f5` 多智能体 e2e · `03cb623`+`13686d8` 推理强度 ·  
  `b79d7c2`+`13686d8` UI P0；四票验收项已勾，04 余 1 项手工回归未执行已注明）。
- **13 / 16 / 25** 已于 2026-09-26 由编排会话完成（委派三轮全灭后编排者亲自实现，地图内联 + 纯 solo）：
  - **13** `done`（`90d2e79`）—— PreToolUse veto / UserPromptSubmit 强制检查、示例 hook + `node scripts/demo-hooks.mjs`（5/5）、18 单测；报告 reports/13-hooks-veto-userpromptsubmit.md。
  - **16** `done`（`e63de15`）—— 注册表快照/按角色 model/maxTurns 强制/CRUD IPC + Subagents 设置页、14 单测；box 8 真实 e2e 未跑已注明；报告 reports/16-custom-subagents.md。
  - **25** `done`（`d0a3c4e`）—— electron-builder NSIS 安装包（224MB）+ `npm run dist` + docs/packaging.md + 打包启动冒烟；box 2 真机人工回归未执行已注明；报告 reports/25-packaging.md。
- **17** `done`（`821fad9` 实现；2026-09-27 真机走查 + 修掉一个真 bug）—— 分叉脚本 `scripts/diag-session-fork.mjs` 四阶段（create 16/16 · verify 18/18 · click 21/21 · cleanup 6/6），真截断 54/133、重启后冷加载、UI 真点 Fork。
  - 走查揪出：`ipc.openSession` 手搓 summary 漏了 `archived`/`derivedFrom`，而渲染端拿它**整条替换**侧栏行 → 打开分叉会话后 `fork` 徽章消失（顺带：打开已归档会话会掉回归档标记）。修法 = summary 只留 `toSessionSummary` 一个来源（`src/main/sessionSummary.ts`），回归 `tests/sessionSummary.test.ts`。
  - 走查另发现 `deleteSession` 不删 PI 转录 → 立 **29**。
- **29** `done`（2026-09-27 编排会话亲自实现）—— 删除顺序 dispose → unlink 转录 → 终端 → 注册表行 → 权限规则（行是唯一指针，行最后才动不到、行前全可失败可中止）；worker 活而 dispose 失败抛 `SESSION_BUSY` 零副作用；共享转录 `shared-kept`；create/fork 回滚跟指针；硬删无撤销 + 已知残余落 `docs/session-deletion.md`。证据：13 单测 + 真机两相走查 `diag-delete-session.mjs`（stage 8/8 · verify 9/9，删父后子冷加载 46 条消息、86→86 基线）+ fork 脚本改后 `click` 22/22；报告 `reports/29-session-deletion.md`。
- **05 / 06 / 07 / 11 / 14** 的工单文件于 2026-09-27 逐项复核收口（代码在 2026-09-27 早已提交，当时只提交了代码没动工单文件）：
  - **05** `done` —— 命令族 / 独立校验 / 轮次上限 / plan 档拒绝 / abort 自动暂停都有代码行号 + 单测；**持久化的重启验证列为未闭环**。
  - **06** `done（部分）` —— 目标卡、按轮分组、三按钮、自然语言映射都在；**「迭代之间的对话流分隔指示」未实现**，具名留下。
  - **07** `done` —— 计划档写拒绝在权限门（不是 prompt）、三路径确认界面、双向互斥都在；本日实跑 `perm-regress` **52/52**。
  - **11** `done（部分）` —— spike 落档、通路、上限与点名拒绝都在；**真机多模态调用未做**（key 限 qwen/deepseek/glm，是否支持图片未实测）。
  - **14** `done` —— Stop 续跑上限 3 + PermissionRequest 可收紧不可放宽都有测试；本日把 `scripts/demo-hooks.mjs` 从 2 个事件扩到 4 个（10/10），补上"示例 hook 验证脚本"这一项。
- **05 / 06 / 07 / 11 / 14 / 22** 已于 2026-09-27 由本会话按依赖序做完并分票提交：
  - **05** `done`（`c3cb5df`）—— goalMode/goalRunner 纯逻辑 + worker 接线 + 目标条，10 单测。
  - **06** `done`（`7ef6208`）—— GoalCard（goalCard.ts 5 单测）。
  - **07** `done`（`107a4b2`）—— planMode/planRunner + PlanCard（产出→批准/驳回/取消）。
  - **11** `done`（`7be2ec6`）—— 图片附件校验与端到端透传，docs/image-attachments.md。
  - **14** `done`（`91a14a8`）—— Stop 续跑 + PermissionRequest 自动决策，hookDecisions 保证 hook allow 不放宽硬拒绝。
  - **22** `done`（`953e410`）—— 插件/hooks 沙箱：来源基线、环境白名单、越权拒绝、授权 UI，37 单测（含 1 条真实子进程环境泄漏断言）；进程启动后的文件访问拦不住已如实写明。
- **18 / 19 / 20** 已于 2026-09-26 认领，并于 15:10 复核后**分别落库**：
  - **19** `done`（`1aca101`）—— 作用域规则、求值顺序（拒绝优先 + HARD_DENY 上移）、规则面板与撤销。  
    遗留「本会话」不落盘 → 拆票 **28**。
  - **18** `done`（`888cd9d`）—— 划选浮层、`#` 会话引用、引用上限。  
    `@` 仍是 fixture、引用没有独立字段 → 拆票 **27**。
  - **20** `blocked`（`5b0e342` 只落了 20a）—— MCP 凭据路径已加密；  
    **模型 API key 仍明文** → 拆票 **26**。状态由"done（部分）"改回 blocked，理由见工单头。
  - 附带：`a809914` 提交了 `ipcGuard`（21 的产物）—— HEAD 里 `customAgentsIpc.ts` 早已 import 它，  
    该模块一直没入库，HEAD 本来编译不过。
- **具名未闭环项收口**（2026-09-27 晚间，编排会话亲自执行，真机/安装证据全部落在各工单 Status 与验收行）：
  - **04** 验收 6：dev 与安装包双环境 `diag-closure-walkthrough.mjs ui` 各 **17/17**（会话 391252bf / a7c72c95）。
  - **05** 验收「持久化重启」+ runner 真机修复（`bd8e699`：verdict 证据归判定轮 / 自动续跑断链 / lastAssistant 读 messages / goals.json 同步写）：`goal-restart` **6/6**，goals.json 会话 a9b5b02f 重启后 `reached · round 2/20`。
  - **06** 撤"部分"：L15 迭代分隔指示**本轮补齐**（`4128b94`——`goalRoundLabel/goalRoundMarkers/goalRoundPlacements` + useChat 插入 + `goal-round-divider` 渲染，单测 9 项），goal 走查 **8/8** 断言分隔 + verifying + 目标卡，安装包 DOM 复核 **5/5**（`第 1/2 次迭代 · 继续`、`第 2 次 · 完成`、`goal-round-1` 分组、`reached · round 2/20 · 96:59`）。
  - **11** 撤"部分"：`image` **10/10**——合成 PNG（`FLEX-42 SAYS HELLO`）粘贴→托盘→Send→模型原文读出（会话 945ba190）；前提 = 模型目录声明 `input:["text","image"]`（`~/.pi/agent/models.json`，否则 Pi 注入"不支持图片"占位）；docs/image-attachments.md §4 已同步。
  - **16** 验收 8：`subagent` **9/9**——saveCustomAgent 建 walker-scribe → 真实 task 回合 14s → `ok (5.9s)` → 产出 `walker-out.txt` → 白名单未绕过（会话 85f9b816）；顺带修出 settings CRUD→worker loader 缓存失效真 bug（`3049ea4` = `registerCustomAgentsIpc(kernel)` + `reloadResources`）。
  - **25** 验收 2：`FlexAgent-0.1.0-setup.exe`（222,703,248 B）`/S` 静默安装 → 安装版 ui **17/17** + 脱敏探针（`apiKeySet=true` 无原始 key、无 key 命名 IPC、model-keys.json 独立在盘）。
- **第二波具名残留收口**（2026-09-27 晚间，六票之外复扫发现 01/18/26 的 done 状态下也压着未勾箱）：
  - **01** 6/6 核验收口：根目录未跟踪 0、`.gitignore` 补 `/.scratch/*`+`!/.scratch/zcode-gap/` 后 `git status` 全净、子系统前缀提交成体系、HEAD 含全部子系统文件与 docs/scripts、`npm run check` 绿。
  - **18** 两箱闭环：`@` 真实文件列举接 27 落库后核验（`qa-workspace-files` **26/26**，renderer `listWorkspaceFiles` 接线在位）；端到端引用补真机 e2e **7/7**（CDP 真 `prompt({references})` → 转录 user 消息含 `<reference kind="file">` 块与文件正文，脚本 `.scratch/probe-ref-e2e.mjs`）。
  - **26** 验收区 7 箱按实际"引用+信封"设计改写并全勾：`probe-keyshape` **5/5**（盘上零原文 key，`ss1` 信封）、`qa-model-key-vault` **29/29**（迁移/坏项/日志）、`qa-model-routing` **34/34**、`qa-model-settings` **20/20**、`diag-security` **32/32**（脱敏负向）；负向验证见 `5efef6b` 落库信息（退回明文直写挂 5 项）。附带修好三个既有破损脚本：`qa-credential-vault` 收尾崩溃（24/24 exit 0）、`qa-context-refs` 目录解析（`registerHooks` 垫片，15/15）、`qa-model-settings` picker 选择器（`composer-model-chip`，20/20）。

## 复核记录（2026-09-26 15:10）

- 报告：`.scratch/zcode-gap/reports/18-19-20-review.md`。复核不采信执行 agent 的自证，  
  四步：文件真存在 → 真接线/真挂载（防死代码）→ 断言真绿 → 负向验证真能捕获。
- **发现 HEAD 本来是坏的**：04:09 那批提交把 `Composer.tsx`、`ChatView.tsx`、`PermissionDialog.tsx`、  
  `SettingsPage.tsx`、`contract/index.ts` 带进 HEAD 时带上了当时工作区里 18/19 的改动  
  （提交信息里有 "shared file, noted in both lanes"），但依赖的新文件没跟进去。  
  HEAD 快照实测缺 6 个模块。本次提交补齐后 typecheck **29 → 24 条**（剩 24 条全在 `worker.ts`，  
  属 16 轨 `getParentModel` 与 10 轨 `respondQuestion` 契约缺失，非本批引入）。
- 教训：**共享文件在脏工作区上被别人整文件 add，是这次 HEAD 变坏的机制**。  
  并行工单结束后应尽快按子系统落库，别让它躺在共享文件的 diff 里等人挑。
- **21 / 23 / 24** done —— WorkBuddy（observability track），2026-09-26。
- **09 / 10 / 12 / 15** done —— 各自执行会话，2026-09-26。

## 暂缓（需产品决策，未开票）

浏览器自动化、定时/闲时任务（B1）、远程 SSH / 手机 Remote / Bot 渠道、Web/TUI 形态、Wiki、辅助对话、编辑历史、会话搜索 FTS5、过期文档刷新（hermes-alignment.md）。
