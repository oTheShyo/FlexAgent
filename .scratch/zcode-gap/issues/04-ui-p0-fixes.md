# 04: UI P0 修复（终端遮挡 / review 遮罩 / a11y 焦点）

**What to build:** 按最近一次 .impeccable critique 清单逐条修复渲染层的 P0/P1 问题：终端抽屉打开时不再吞掉聊天输入框（composer 可正常聚焦输入）；review 遮罩不再以禁用 Accept 的状态阻塞用户（要么可接受、要么可关闭，不会卡死当前任务）；权限对话框具备焦点陷阱、Escape 关闭语义（拒绝并归还焦点到触发元素）；关键交互（权限确认、diff 审查、composer）键盘可达，对比度达到 WCAG AA 基线。不可恢复的错误要提供重试/退出路径，不允许白屏死局。

**Blocked by:** 01 (落库未提交子系统)

**Status:** done (committed b79d7c2 + 13686d8; report: reports/04-ui-p0-fixes.md; 验收第 6 项已于 2026-09-27 真机执行——dev 与安装包双环境 `scripts/diag-closure-walkthrough.mjs ui` 均 17/17)

- [x] 终端抽屉与 composer 不再互相遮挡：打开终端后仍可聚焦输入并发送消息
- [x] review 遮罩：Accept 可点击或存在明确的关闭/拒绝路径，无禁用态死锁
- [x] 权限对话框：焦点陷阱生效、Escape 触发拒绝并把焦点还给触发元素
- [x] 权限确认、diff 审查、composer 三处可纯键盘完成操作
- [x] critique 文件中的 P0/P1 条目逐条勾销（在工单产出中列出对照）
- [x] 主流程手工回归：发消息 → 权限确认 → diff 查看 → 终端开关，均正常（2026-09-27 CDP 真机走查执行：dev 环境 17/17（会话 391252bf，权限对话框 allow-once、diff 面板 2ms 自动打开并可 Accept、Ctrl+T 终端抽屉中 composer 可输入并发送得 TERMINAL-OK）；安装包环境复跑 17/17（会话 a7c72c95，见 25 号安装回归）。脚本 `scripts/diag-closure-walkthrough.mjs ui`，结构证明 + 门禁 + 对比度脚本仍见 reports/04-ui-p0-fixes.md）
