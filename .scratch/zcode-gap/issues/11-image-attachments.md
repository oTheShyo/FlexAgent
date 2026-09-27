# 11: 图片附件（截图进上下文）

**What to build:** 用户可以把截图/图片粘贴或拖进 composer 作为附件随消息发给模型，模型能实际"看到"图片内容（例如贴一张报错截图让它分析）。当前实现明确拒绝图片、仅支持文本。本工单先做可行性 spike 落档（PI SDK 是否支持多模态内容块；若不支持，确定等价通路并记录决策），再打通端到端：composer 接收图片 → contract 扩展（含 mock 同步）→ 模型收到并响应。保留现有文本附件的大小/数量上限策略，图片同样有明确上限与超限提示（不静默截断）。

**Blocked by:** 01 (落库未提交子系统), 02 (工程工具链)

**Status:** done（部分）（`7be2ec6`；2026-09-27 逐项复核）— **1 项未做**：真机多模态调用

## 收口（2026-09-27）

- [x] spike 结论落档：多模态通路是否可行、选了哪条路、为什么 — `docs/image-attachments.md` §1：内核原生支持（`PromptOptions.images?: ImageContent[]`，`agent-session.d.ts:156/417`），三条备选各自为什么不选；结论是"不需要回退路径"
- [x] 粘贴/拖拽图片出现在 composer 附件区，可移除 — `composerAttachments` 读 base64 并按上限拒绝，附件托盘带移除
- [ ] 端到端成功用例：发送截图后模型对图片内容作出正确响应（留证据） — **未做**。本机 API key 限 qwen / deepseek / glm，是否支持图片输入未实测；文档 §4 已如实写明"真机验证留给有可用多模态模型时补"。通路按内核契约打通，但**没有**"模型真的看懂了图"的证据。
- [x] contract 与 mock 同步更新，mock 模式下不回归（M 系列验收仍绿） — `ImageAttachment` / `PromptInput.images?` / `IMAGE_ATTACHMENT_LIMITS` 进契约，mock 同步；本日全量 **228/228** + lint / typecheck×3 / build 全绿
- [x] 数量/大小上限与超限提示明确 — `IMAGE_ATTACHMENT_LIMITS`（`contract/index.ts:367`）：每消息 4 张、单张 5 MB、合计 12 MB、白名单 png/jpeg/webp/gif；两侧共用同一常量，超限**点名拒绝**（渲染端托盘提示 + 主进程 `PromptAck.notices`）
- [x] 不可行时的回退路径：明确的拒绝提示 + 决策记录（不允许无声失败） — 不需要回退路径（内核支持）；"拒绝不静默"仍成立：超限一律点名，空文本 + 有图片合法，空文本且无附件仍拒绝

**未闭环**：`maxImages: 4` 与常见 GUI 期望的 5 张不同（上一轮口头记的是 5/20MB，代码与文档是 4/5MB/12MB——**以代码为准**，本行即纠错）。
