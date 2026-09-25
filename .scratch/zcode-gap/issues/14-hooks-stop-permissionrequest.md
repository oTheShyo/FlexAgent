# 14: Hooks 扩展②：Stop block 续跑 + PermissionRequest 自动决策

**What to build:** 在工单 13 的协议基础上补齐另外两个高价值事件。(1) Stop：主模型准备结束回合时触发，hook 返回 block + 理由则当前模型循环继续（例如"还没给出测试命令和结果，补齐再结束"），连续 block 达上限（3 次）后强制结束防死循环。(2) PermissionRequest：仅在权限结果需要询问用户时触发，hook 可自动 allow 或 deny 并附理由——deny 优先于 ask、ask 优先于 allow 聚合；硬拒绝（HARD_DENY）与凭据路径边界不可被 hook 的 allow 绕过。两者都进权限链的既有回归套件。

**Blocked by:** 13 (Hooks 扩展①：PreToolUse veto + UserPromptSubmit)

**Status:** ready-for-agent

- [ ] Stop hook 返回 block → 模型继续一轮，理由模型可见；连续 3 次后强制结束并记录
- [ ] PermissionRequest hook 触发时机正确：仅在需要询问用户时
- [ ] hook allow/deny 生效，聚合顺序 deny > ask > allow
- [ ] HARD_DENY 与凭据路径边界不可被 hook allow 绕过（有反向测试用例）
- [ ] 权限链回归套件全绿（perm-regress 扩展新用例）
- [ ] 示例 hook + 验证脚本入库
- [ ] 插件/hook 文档补全这两个事件的契约
