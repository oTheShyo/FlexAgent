# 图片附件（ticket 11）

把截图/图片粘贴或拖进 composer，随消息发给模型，模型真正"看到"像素而不是一个它打不开的路径。

## 1. 可行性 spike 结论

**结论：内核原生支持，不需要回退路径。**

`AgentSession.prompt(text, options)` 的 `PromptOptions` 带 `images?: ImageContent[]`
（`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts:156`，签名在
`:417`）。`steer()` / `followUp()` 同样收 `images`。`ImageContent` 的形状是
`{ type: 'image', data: <base64>, mimeType }`。

因此**不做**以下备选（记录决策，避免后来者重新走一遍）：

| 备选 | 为什么不选 |
| -- | -- |
| 把图片存盘、把路径写进 prompt | 模型没有这个文件的读权限语义；工单 27 的引用机制才是"给路径"的正解，两者不是一回事 |
| 内联 base64 进文本 | 模型看到的是噪声，且同一份字节在上下文里被计两次 |
| 自行缩放/转码 | `_normalizePromptImages` 已按 `model.inputLimits.images.resize` 自动处理（`agent-session.js:1179`）；前端再转一次是重复劳动且丢画质 |

前端只负责：识别类型 → 读成 base64（无 `data:` 前缀）→ 随 `PromptInput.images` 送出。
`sendUserMessage(content)` 也收 `TextContent | ImageContent[]`，但走 `prompt` 的 options
更贴合本仓已有的 prompt 通道（disposition / recall / promptContext 都挂在那里）。

## 2. 通路

```
Composer（粘贴/拖拽）
  → composerAttachments.stageAttachments  读 base64、按上限拒绝并给出理由
  → onSend(text, references, images)
  → useChat.send → codexApi.prompt({ ..., images })      ← contract 新增字段
  → ipc: validateImages() 再校验一次（渲染端不是边界）    ← 超限转 notices，不静默丢
  → worker: session.prompt(text, { images })             ← 内核原生
```

文本附件的行为完全不变（仍内联进 prompt 正文）；图片不进正文。

## 3. 上限与提示

`IMAGE_ATTACHMENT_LIMITS`（`src/shared/contract/index.ts`），两侧共用同一份常量：

| 项 | 值 |
| -- | -- |
| 每消息图片数 | 4 |
| 单张 | 5 MB |
| 单消息合计 | 12 MB（故意低于 4 × 5 MB：一条消息是一个 IPC 载荷、也是一个上下文窗口） |
| 允许类型 | `image/png`、`image/jpeg`、`image/webp`、`image/gif` |

文本附件沿用既有上限（5 个 / 64 KB 单文件 / 192 KB 合计），两类分别计数。

**超限一律点名拒绝**，不做静默裁剪或丢弃：渲染端在附件托盘下方显示
`Not attached: shot.png — too large (...)`；主进程校验失败则随 `PromptAck.notices`
回传同一句话。空文本但有图片是合法消息（截图不带说明是常态）；空文本且无附件仍拒绝。

## 4. 证据与回归

- 单测：`tests/imageAttachments.test.ts`（base64 解码长度、类型白名单、`data:` 前缀、
  非 base64、数量与大小上限、非对象输入不抛异常）。
- 端到端真模型调用已补（2026-09-27，`scripts/diag-closure-walkthrough.mjs image` 10/10）：
  合成 PNG（唯一文字 `FLEX-42 SAYS HELLO`）粘贴进 composer → 附件托盘 → 发送 →
  模型原文读出该短语。**前提**：模型目录条目要声明 `"input": ["text", "image"]`
  （`~/.pi/agent/models.json`），否则 Pi 对该模型注入"不支持图片"占位并省略图片块；
  本次为 `claude-sonnet-4-6` 声明后经 `setModel` 切换验证通过。
