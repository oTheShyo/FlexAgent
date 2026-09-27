# 06: 目标模式 UI（目标卡 + 迭代摘要 + 控制入口）

**What to build:** 为工单 05 的目标状态机补全可视化界面：会话侧栏出现目标卡片（目标描述 + 已用时间），下方按迭代分组展示每一轮完成的清单项（清单项归属其首次出现的那一轮，即使后续轮次才完成也不挪组），最底部显示当前轮进度与待办。提供暂停/恢复/清除按钮；用户可用自然语言直接改目标（替换/暂停/清除），无需记命令。状态与 05 的状态机双向同步，正在自动续跑时有明确的进行中指示与停止入口。

**Blocked by:** 05 (目标模式核心)

**Status:** done（`7ef6208` GoalCard + `4128b94` 本轮补齐迭代分隔指示 + 真机走查收口，见下）

## 收口（2026-09-27）

- [x] 目标卡片展示描述与已用时间，自动续跑期间可见"进行中"状态 — `GoalCard.tsx:36-44`：描述 + `goal-card-meta`（状态 · round N/M · `formatElapsed`）+ `running` 时追加 `· verifying…`（`running` = active 且末轮无 verdict）
- [x] 迭代按轮分组，清单项归属首次出现轮；当前轮进度与待办单独展示 — `groupTodosByRound`（`goalCard.ts:49`）用 `seen` 记住首次出现轮，后续轮完成只在首现轮标 done；渲染 `goal-round-<n>` 分组；`goal-progress` 显示未完成项数
- [x] 暂停/恢复/清除按钮可用，点击后与状态机一致（含持久化） — 三个按钮 `goal-pause`/`goal-resume`/`goal-clear` 发 `/goal pause|resume|clear`，与 05 的同一条状态机与落盘路径；持久化的重启验证已由 05 的 goal-restart 6/6 补齐
- [x] 自然语言调整目标（"换个方向"/"先停一下"/"这个目标不要了"）正确映射到替换/暂停/清除 — `mapGoalAdjustment`（`goalCard.ts:21`）覆盖 clear/pause/resume/replace 四类中英文措辞，拿不准一律 `none`（当普通消息发出去）；单测 `tests/goalCard.test.ts` 5 项
- [x] 自动续跑轮次之间对话流有分隔指示（第 N 次迭代 · 继续/完成） — 2026-09-27 本轮实现（`4128b94`；此前确为未实现，原行属实）：`goalRoundLabel`/`goalRoundMarkers`（`goalCard.ts`，每轮 `继续` + 完成判定补 `完成`），useChat 在 goal 事件与冷加载插入（`insertGoalRoundMarkers`），`ChatView.tsx` 渲染 `goal-round-divider`；单测 9 项（goalCard 5→14）。真机证据：goal 走查 8/8 断言分隔+verifying+目标卡（会话 a9b5b02f）；安装包环境 DOM 复核 5/5（`第 1 次迭代 · 继续`、`第 2 次迭代 · 继续`、`第 2 次迭代 · 完成`）
- [x] 停止按钮触发后目标进入暂停，不再消耗额度 — `worker.ts:2825-2836`（abort → `/goal pause` + 事件）

**未闭环**：无——真机走查已补（2026-09-27）：goal 8/8 + goal-restart 6/6 真模型跑出主动续跑（`verifying…`、分隔、目标卡均在走查中断言），安装包环境 DOM 复核 5/5（`goal-round-divider` ×3、`goal-round-1` 分组、`goal-card-meta` = `reached · round 2/20 · 96:59`）。
