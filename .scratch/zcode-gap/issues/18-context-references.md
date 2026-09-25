# 18: 上下文引用补全（@文件列表 + 划选追问 + #历史会话）

**What to build:** 补齐三块上下文注入体验。(1) @mention 文件列表：实现工作区文件枚举（当前缺口，@ 触发后列出可引用文件/文件夹），大仓库要分页/限流/防卡顿。(2) 划选追问：选中对话中任意一段文字（助手回复、推理、工具结果）浮出"添加到当前任务"，作为引用进入输入框；流式输出中划选则固定当刻文本。(3) `#` 引用历史会话：搜索并把既有会话的上下文带入当前任务。三者共享引用管理：条数与长度有上限，超限明确提示而非静默截断，已写草稿不受影响。

**Blocked by:** 01 (落库未提交子系统)

**Status:** in-progress (认领 2026-09-26) — 本单范围是 (2)(3)(4)(5)(6)；(1) 已存在，经核对确认后标注为「已实现但不完整」

## 现状核对（2026-09-26）

| 验收项 | 现状 |
| -- | -- |
| @ 触发列出工作区文件 | **已实现**：Composer 的 @ 触发补全已存在（mention 查询/过滤/键盘导航）。**但列表是 renderer 内的静态 fixture**（`composerFiles.ts` 的 `COMPOSER_FILES`），不读磁盘；选中只把 `@path` 以纯文本写进草稿，**不读取文件内容** |
| 划选追问浮层 | 缺失 → **已实现**（`hooks/useChatSelection.ts` + `components/SelectionToolbar.tsx` + ChatView 接线） |
| # 引用历史会话 | 缺失 → **已实现为「片段引用」**（见下方评估），完整上下文带不进来 |
| 引用上限明确提示 | 未实现 → **已实现**（`composerReferences.ts`） |
| 端到端验证 | 待做 → **部分完成**（见下） |
| 列表防抖/缓存 | 未验证 → **已实现**（防抖 + 缓存；但数据源是 fixture，本身不做磁盘扫描） |

## 实现要点

- `components/composerReferences.ts`（新）：三种入口共用的引用模型。
  - 上限：单条 8,000 字符、整条草稿 24,000 字符、最多 8 条。
  - 超限一律**拒绝并给出可读原因**，绝不截断：截短会向模型发送一段从未存在过的文字，而拒绝至少是可见的。
  - `kind`（selection/session）+ `partial` 记录「这条引用到底代表什么」，`formatReferencesBlock()` 生成 ASCII 定界块。
- `hooks/useChatSelection.ts`（新）：选区捕获。选区在 settle 的那一刻被拷进 state，之后**不再回读 DOM**——所以流式 delta 无法覆盖已经固定的引用。滚动只做重测量；底层 DOM 节点被 React 换掉（`partial` → `message`）就收掉浮层，而不是让它飘在空处。
- `components/SelectionToolbar.tsx`（新）：`position:fixed` 浮层，显示来源与字符数。
- `components/ChatView.tsx`：`data-selection-source` 标记行类型，root 同时作为选区宿主容器，`onAddReference` 把冻结文本交给上层。
- `components/Composer.tsx`：`#` 触发会话列表；引用托盘（可删、显示 x/8 与字符数、显示拒绝原因）；提交时 `composePrompt(text, attachments, formatReferencesBlock(references))`。
- `hooks/useDebouncedValue.ts`（新）+ `lib/debounce.ts`（新）：`@` 列表查询防抖 120ms + 按查询缓存；`#` 会话搜索防抖 250ms（与 Sidebar 一致）+ 按查询缓存。
- `App.tsx`：持有 references 状态；切换会话即清空（引用属于它被摘出来的那份记录）。

## 技术判断：划选 × 流式输出

- 流式行是 `<AssistantContent>` 的单一文本子节点，React 更新时只改 `nodeValue`，不换节点。但文本是追加的（`content + delta`），锚点偏移随之漂移；`message_end` 把 `partial` 换成 `message` 时才会换 DOM 节点，那时选区直接失效。
- 结论：**不能靠「选区还在 DOM 里」来工作**。因此捕获即拷贝、浮层只跟随快照、节点失联即隐藏。这样流式中划选固定的是当刻文本，后续 delta 只对「还没被摘走的那段」生效。
- 已知限制：**只支持单行选区**。跨行拖选（跨两条消息，或工具结果 `<pre>` 内的多行）不出现浮层——把浮层锚在一个已经不在原处的片段上，比什么都不显示更糟。

## 技术判断：`#` 会话引用 vs 记忆召回

不是同一件事，代码里也没有混：

| | `#` 会话引用（本单） | 记忆召回（`recallForPrompt` → `recallSlot` → `before_agent_start`，main 侧） |
| -- | -- |
| 触发 | 用户显式挑选一条会话 | 每次 prompt 按正文自动抽查询词检索 |
| 内容 | 那是**一条会话**的上下文 | 若干**事实卡片** |
| 可见性 | 用户看见引用条，也看见进 prompt 的文字 | 全程静默，用户看不到 |

因为当前 API 只能给到片段，本单的 `#` 是「片段引用」：标题命中（本地列表，零往返）与 `searchSessions()` 命中的片段合并去重，标题命中标记为 `partial`，芯片写「title only」，进 prompt 的话也会写明「该会话的正文无法从这里取到」。把它包装成完整上下文会是假的。

## 验收状态

- [x] 划选助手回复/工具结果出现浮层，点击后引用进输入框；流式中划选固定当刻内容
- [ ] @ 触发列出工作区文件，选择后引用进入输入框；大仓库打开不卡（有上限/分页）
  - 补全与键盘导航可用；**列表来源与内容读取都缺后端**（见 `## Blocked by (new)`）。fixture 不扫描磁盘，所以「打开不卡」暂时没有对手，但也没有被真正验证过。
- [x] `#` 可搜索历史会话并引用带入
  - 但只带片段/标题，**不带完整上下文**。Picking 的会话标题 + 命中片段会进 prompt。
- [x] 引用条数/单条长度/总字数上限，超限明确提示，已有引用与草稿不受影响
- [ ] 带引用发送后，模型上下文中确实包含被引用内容（端到端验证）
  - 已验证到 renderer 边界：`composePrompt()` 的输出里，草稿、附件、引用块逐字都在（脚本 `scripts/qa-context-refs.mjs` 断言）。
  - 未验证：`codexApi.prompt()` 之后的 kernel 侧。`PromptInput` 只有 `{sessionId, text, mode}`，引用没有独立字段，只能塞进 `text`；kernel 会把它当普通用户文本（`@` 提及的 path token 同理）。
- [x] 列表数据来源有防抖/缓存，不会每次按键全量扫描磁盘
  - 防抖与缓存都在位；数据源是 fixture，磁盘扫描这件事今天并不存在。

## Blocked by (new)

以下都在 renderer 之外，本单按约束没有自己加 IPC：

1. **`listFiles({ sessionId, query })`**（主进程 + 契约）：`@` 才有真的工作区文件枚举，也才会有「大仓库不卡」这个说法被真正验证。目前的 `COMPOSER_FILES` fixture 在 `composerFiles.ts` 顶部已注明是占位。
2. **文件内容读取通道**：`@` 选中后要能把文件内容内联进 prompt。可行的路子是给 `PromptInput` 增一个可选的 `references?: ContextReference[]`（契约只增不改），由 main 侧按引用解析路径并内联；或者放开一个 `readFile(path)`。今天 `@path` 只是草稿里的一个字符串，模型看到的是路径而不是内容。
3. **`readSessionContext(sessionId, { range? })`**：不切换当前会话地取回某条会话的正文（或指定区间）。`openSession()` 会把当前视图/订阅换掉，不能用来「顺便读一下」；`searchSessions()` 只给约 200 字符片段。缺这个，`#` 就只能是片段引用。
4. **`PromptInput.references`（同上第 2 条）**：引用不必伪装成用户写的正文，也不必硬塞在草稿末尾。

## 回归与验证

- `node --experimental-strip-types scripts/qa-context-refs.mjs` — 15 项断言（上限、拒绝原因、草稿与既有引用不受影响、引用逐字进 prompt、@ token 进 prompt、块定界、防抖、缓存）。
- 负向验证已做：逐个摘掉「单条长度上限 / prompt 拼引用块 / 列表缓存」后，对应断言分别 FAIL，证明不是空测。
- `npm run typecheck`、`npm run build`：绿（另两个并行工单在此期间改动的 `api/index.ts` / `api/mock.ts` 曾短暂红，属他人改动，与本单无关）。
- 未做：Electron 内真实走查（无头环境本单未启动 dev server），浮层的视觉与鼠标行为仅经 typecheck/build 与代码审查确认。
