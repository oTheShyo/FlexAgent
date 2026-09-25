# 13: Hooks 扩展①：PreToolUse veto + UserPromptSubmit

**What to build:** 打通两个关键 hook 事件，收口 gap-audit B8/B10。(1) PreToolUse veto：hook 进程以约定退出码退出并返回拒绝理由时，对应工具调用被真实拦截、理由回传给模型（模型知道为什么被拒并可调整），拦截结果可观测。(2) UserPromptSubmit：模型请求发起前触发，hook 可追加模型可见的上下文，也可阻断本次请求并把原因反馈给用户；不能改写原始 prompt。两者都复用现有 hook 运行器的超时/输出上限/诊断语义，matcher 按工具名过滤。附带一个可运行的示例 hook 与验证脚本，并更新插件文档。

**Blocked by:** 01 (落库未提交子系统), 02 (工程工具链)

**Status:** ready-for-agent

- [ ] PreToolUse hook 返回拒绝 → 工具不执行，拒绝理由进入模型上下文，事件日志可查
- [ ] PreToolUse matcher 按工具名过滤（如仅 Write|Edit 生效），不匹配的工具不受影响
- [ ] UserPromptSubmit hook 可注入 additionalContext（模型首轮可见）
- [ ] UserPromptSubmit 可阻断本次请求，用户看到阻断原因，主模型不被调用
- [ ] 超时、非 JSON 输出、异常退出均按现有诊断语义处理，不拖垮会话
- [ ] 示例 hook + 验证脚本入库（能一键演示两个事件）
- [ ] 协议解析与 veto 决策有 vitest 单测
- [ ] 插件/hook 文档更新：事件、输入契约、退出码语义
