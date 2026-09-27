# 05: 目标模式核心（/goal + 每轮校验 + 自动续跑）

**What to build:** 用户在会话里输入 `/goal <目标描述>` 设定一个可校验的会话目标。每一轮回复结束后，系统独立发起一次校验：目标未达成 → 给出下一步并自动开启下一轮，无需用户手动说"继续"；达成 → 输出收尾总结并停止。校验只认可实据（改动的文件、命令输出、测试结果），计划、待办清单、"听起来像结论"的回复不算完成；仍有未完成清单项时优先做完。目标状态持久化：暂停/恢复/清除/替换可用（也支持自然语言调整），重开会话目标还在；轮次有上限保护防止无限烧 token；计划模式下拒绝设定目标并提示先切换模式。

**Blocked by:** 01 (落库未提交子系统), 02 (工程工具链)

**Status:** done（`c3cb5df`；2026-09-27 逐项复核补证）

## 收口（2026-09-27）

- [x] `/goal`、`/goal pause`、`/goal resume`、`/goal clear`、`/goal replace <新目标>` 均可用；无参时展示当前目标 — `parseGoalCommand`（`goalMode.ts:49`）解析 set/pause/resume/clear/replace/show；单测 `tests/goalMode.test.ts:17`「parses the command family」、`:32`「case-insensitive … rejects non-commands」
- [x] 每轮结束触发独立校验；校验 prompt 要求出示实据，纯计划/纯叙述不判完成 — `buildVerifyPrompt`（`goalMode.ts:138`）；worker 在 `agent_settled` 后走 `maybeRunGoalStep`；单测 `:67`「a complete verdict without evidence does not reach the goal」、`:77`「demands evidence and carries the proposed next step」
- [x] 未达成自动续跑，带轮次上限（达到上限暂停并说明）；达成输出收尾总结 — `DEFAULT_GOAL_MAX_ROUNDS = 20` + `canVerify`/`beginIteration`；单测 `:41`「verifies only while active and under the cap, one round at a time」、`:56`「resumes from pause and cap but not from reached」；`parseVerdict` 的完成判定单测 `:93`–`:111`
- [x] 目标与迭代进度持久化 — `goalRunner` 落盘（`GOALS_FILE`），读写走 `readGoal`/`setGoal`（写路径本轮改为同步 tmp+rename，`bd8e699`）。**重启验证已补（2026-09-27）**：`scripts/diag-closure-walkthrough.mjs goal-restart` 6/6——设标 → 重启 app → 目标恢复并续跑到 `reached`；落盘 `goals.json` 会话 a9b5b02f 重启后仍在（`reached · round 2/20`，安装包环境 DOM 二次确认）。
- [x] 计划模式下设定目标被拒绝并给出原因提示 — `goalRunner.ts:88`：`set`/`replace` 在 `plan` 档返回「Goal mode is unavailable in plan mode — switch out of plan mode first.」，worker 转 `INVALID_INPUT`（`worker.ts:2912`）
- [x] 中途停止任务时目标自动暂停，不会在用户不知情时继续消耗 — `worker.ts:2825-2836`：`abort` → 若 `hasActiveGoal` 则执行 `/goal pause` 并 emit `Goal paused — the run was stopped.`
- [x] 校验与续跑逻辑有单测（纯逻辑层，跑在 vitest 上） — `tests/goalMode.test.ts` 10 项；本日全量 228/228
- [x] UI 富交互（卡片、清单分组）留给工单 06，本工单以命令行式交互 + 最小可视状态为验收 — GoalCard 属 06；05 只提供 `/goal` 命令面与目标条
