# 07: 计划模式 UX（先计划 → 确认 → 执行）

**What to build:** 把已有的 plan 权限档（禁写）升级为完整的计划-确认-执行交互流，收口 gap-audit 的 B3。进入计划模式后，Agent 只读调研并产出一份结构化计划（步骤清单），用户可修改、批准或驳回；批准前所有写操作被权限层拦截（不是仅靠 prompt 约束）；批准后进入执行，计划作为上下文推进。与目标模式互斥：已有目标时提示先处理目标，反之亦然（对齐 ZCode 行为）。

**Blocked by:** 05 (目标模式核心)

**Status:** done（`107a4b2`；2026-09-27 逐项复核）

## 收口（2026-09-27）

- [x] 计划模式下 Agent 产出结构化计划，期间所有写文件/执行命令被权限层实际拒绝 — 拒绝发生在权限门而非 prompt：`permissionGate.ts:624-631`，`plan` 档只放行纯读工具，其余 `deny`（reason「plan mode blocks writes」）；计划由 worker `maybeDraftPlan` 产出（`planRunner`）
- [x] 计划确认界面：批准 / 驳回修改 / 取消三路径可用 — `PlanCard.tsx`：`plan-approve` / `plan-reject` /（驳回后）`plan-send-feedback` / `plan-cancel`，步骤清单渲染在 `plan-steps`
- [x] 批准后写操作解锁并按计划执行；确认前的写尝试有日志可查 — `respondPlan` → `setPermissionMode` 离开 plan 档；被拦下的写**计入计划状态**（`worker.ts:1738` → `planRunner.ts:82` `blockedWrites` 计数），不是写进文件日志——"可查"的实现形式是计划卡片上的计数，不是日志行；`worker.ts:2891` 另外规定离开 plan 档时丢弃未批准的草案
- [x] 与目标模式互斥：两种模式的冲突有明确提示与切换引导 — 两个方向都有：`goalBlocksPlan`（`worker.ts:2882`，带目标时拒绝进 plan 档）与 `goalRunner.ts:88`（plan 档下拒绝设/换目标）
- [x] 切换执行模式（Shift+Tab 或菜单）后新语义立即对当前会话生效 — `setPermissionMode` 是内核请求，按会话改 `host.mode`（`worker.ts:2876+`）。**未真机走查**：走查需要真模型跑一轮才看得到切换后的实际拦截。
- [x] 回归：非计划档的权限行为不变（perm-regress 用例全绿） — 本日实跑 `node scripts/perm-regress.mjs` → **52/52 PASS**（含 MCP 语义、bash/文件工具分类、作用域规则与两条不可越界边界）

**未闭环**：计划模式的真机流程（进 plan → 只有读工具成功 → 产出计划 → 批准 → 写解锁）没有端到端走查，证据是权限门单测级 + perm-regress 回归。
