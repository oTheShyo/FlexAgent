# 10: 提问超时自动继续

**What to build:** Agent 主动向用户抛出选择题（"方案 A 还是 B"）时，问答面板带 5 分钟倒计时；到点仍未回答，Agent 按自身判断选一个方向继续推进，历史中标记"未回答，已自动继续"。用户任何动作（悬停面板、开始选择、点秒数、侧栏停止计时）都永久停止该问题的倒计时。设置里可全局关闭此行为（默认开启）。注意边界：只有普通提问受倒计时约束，权限请求与计划审批永远等待，不受影响。

**Blocked by:** 01 (落库未提交子系统)

**Status:** done

- [x] 提问面板显示 5 分钟倒计时，运行中可见剩余时长
- [x] 超时后自动继续，历史记录带"未回答，已自动继续"标记
- [x] 悬停/点击/选择/侧栏"停止计时"任一交互永久停表（不可恢复计时）
- [x] 设置项"提问自动继续"可关闭，关闭后提问无限等待；开关只影响新产生的提问
- [x] 权限请求与计划审批不进入倒计时
- [x] 倒计时中止/超时路径有单测覆盖

## 交付记录

- 新增 `src/main/questionTimeout.ts`（纯状态：stop 永久、关闭即永不超时、到期是时刻不是时长）+ `tests/question-timeout.test.ts` 5/5。
- 新增 `ask_user` 工具（`src/main/askUser.ts`，经 extensionFactory 注册）：没有工具就没有可挂倒计时的东西——用散文提问无法阻塞、无法超时、无法在历史里标记。
- Worker：`question_request` / `question_resolved` 事件 + `respondQuestion` / `stopQuestionTimer` 请求；倒计时在**提问产生时**读取设置（开关只影响新提问）；timeoutMs=0 时无限等待；run settle 会释放仍挂着的提问。
- UI：`QuestionPanel`（选项 + 自由输入 + 剩余时长），**任意交互**（hover/focus/click/点秒数）即永久停表；超时后在聊天流插入 notice「Question went unanswered — continuing automatically.」。
- 权限请求与计划审批走 `permission_request`，完全不进入倒计时路径。
- 偏差：验收里提到的「侧栏停止计时」做成了面板内的控制（点剩余时长即停表），没动 Sidebar（他人在改）。
