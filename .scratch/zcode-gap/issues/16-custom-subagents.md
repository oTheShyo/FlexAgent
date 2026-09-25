# 16: 自定义子智能体（定义文件 + 设置页 + 工具白名单）

**What to build:** 用户可创建可复用的子智能体角色（如 code-reviewer、test-writer）：定义为带 frontmatter 的 Markdown 文件（name、description、model、tools、maxTurns、系统提示词正文），设置页提供创建/编辑/启停/删除界面。主模型依据 description 自动选用，用户也可在聊天中显式 @ 调用。工具白名单真实生效（自定义后子智能体拿不到清单外工具，含 MCP 工具的显式声明规则）；未指定 model 时跟随主会话模型。现有内置 roles 不回归，e2e 底座已由工单 03 验证。

**Blocked by:** 03 (多智能体端到端验证)

**Status:** ready-for-agent

- [ ] 定义文件格式落档并被加载（frontmatter 校验：缺 name/description 时忽略并有诊断）
- [ ] 设置页：创建/编辑/启停/删除全流程可用，内置角色不可删改
- [ ] 工具白名单实测生效：自定义 tools 后清单外工具调用被拒
- [ ] description 进入主模型上下文，模型可自动选用；聊天中 @ 可显式指定
- [ ] 指定 model 时用指定模型，未指定时跟随主会话模型
- [ ] maxTurns 生效
- [ ] 修改定义的生效时机明确（新会话生效），界面有提示
- [ ] 至少创建一个自定义子智能体完成一个真实任务的 e2e 用例（留证据）
