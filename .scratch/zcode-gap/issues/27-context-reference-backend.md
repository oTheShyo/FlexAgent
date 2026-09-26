# 27: 上下文引用后端（接住 18 的前端）

**What to build:** 给 18 已交付的引用 UI 补上它缺失的后端能力。`@` 目前列的是 renderer 内的静态
fixture，选中后只把路径字符串拼进草稿 —— 模型看到的是路径，不是内容。`#` 只能给标题 + 约 200 字符
片段。引用本身没有独立通道，只能伪装成用户正文塞进 `text`。

**Blocked by:** 18（前端已 done 并落库 `888cd9d`）

**Status:** done — 落库 `8206c92`（`@`）与 `9498490`（`#`），2026-09-26 16:30

## 落地结论（与工单原文的两处偏离，都是实测后改的）

**1. `references` 停在契约层，不到 kernel。** 内核 `prompt(text: string, options)` 只收字符串
（`agent-session.d.ts:417`），没有结构化引用面。所以"引用走独立字段"成立到 IPC 为止，
最终仍渲染成文本 —— 但渲染位置变了：从 renderer 挪到 main，因为只有那里能打开文件。
收益是真实的三条：文件内容能内联、上限在后端强制、引用可被计数与省略。

因此验收第 4、5 条按下面的口径判定，不能照原文：
- 「kernel 侧确实收到 references」**不可达**，内核无此面。
- 「可被裁剪/计数」成立的是我们这一侧：超限引用按名省略（不是静默截断），
  引用条数与字符数有独立字段可统计；内核仍把它们当普通正文。

**2. 扫描放 main 不放 worker。** `RegistryRecord.cwd` 已在 main 侧（`registry.ts:11`），
且 worker 是 agent 运行的线程 —— 用户打字时走一遍目录树不该 stall 一个在跑的 run。

## 已交付

| 能力 | 落点 |
| --- | --- |
| `PromptInput.references` | `contract` 只增；`useChat.send` 第三参 |
| `listFiles` | `src/main/workspaceFiles.ts`：有界扫描（深度/条目/结果）+ 按 root 缓存 + `invalidateWorkspaceFiles` |
| 文件内容内联 | `src/main/promptReferences.ts` `renderReferences`；路径解析后**校验仍在 cwd 内** |
| `readSessionContext` | worker `case 'readSessionContext'`：attach → 读 → `finally` dispose，不留订阅/会话表项 |

`composerFiles.ts`（fixture）已删除 —— 留着会是同一个谎言的第二个来源。

## 四项能力（按价值排序，可分批）

### 1. `PromptInput.references`（契约，**先做这条**）

给 `PromptInput` 加可选字段 `references?: ContextReference[]`（**只增不改**）。
理由：引用今天只能塞进 `text`，后果是 kernel 把它当普通用户文本 —— 不可裁剪、不可计数，
压缩时也不会被区别对待。有了独立字段，引用才是引用。

### 2. `listFiles({ sessionId, query })`

`@` 才有真的工作区文件枚举。要求：大仓库打开不卡（分页或上限），有防抖与缓存的落点
（前端防抖已就绪，缺的是数据源）。当前的 `COMPOSER_FILES` fixture 在
`composerFiles.ts` 顶部已注明是占位，替换时那个注释要一起删掉。

### 3. 文件内容读取通道

`@` 选中后要把文件内容内联进 prompt。两条路：按引用解析路径并在 main 侧内联，或放开一个
`readFile(path)`。**不要让用户选了文件却只送去一个路径** —— 那在体验上是骗人的。

### 4. `readSessionContext(sessionId, { range? })`

不切换当前会话地取回某条会话的正文（或区间）。`openSession()` 会把当前视图/订阅换掉，
不能用来"顺便读一下"；`searchSessions()` 只给约 200 字符片段。缺这个，`#` 只能是片段引用。

## 验收

- [x] `@` 列出的是真实工作区文件（不是 fixture），大仓库不卡
      —— `qa-workspace-files.mjs`：真实临时树、跳过 node_modules/.git、缓存与失效
- [x] `@` 选中后文件内容进 prompt，不是只有路径
      —— 同上：读得到内容；读不到则**点名**（目录/二进制/越界/缺失各有 notice）
- [x] `#` 能把一条历史会话的上下文带进来
      —— `renderSessionTranscript`，上限停在整条消息边界；读失败降级为原片段 + partial
- [~] 引用走 `references` 字段，不再拼进 `text`
      —— 已做（renderer 不再拼 `formatReferencesBlock`）。
      **「kernel 侧收到」不可达**：内核 `prompt()` 只收 string，无结构化面。
- [~] 引用可被裁剪/计数
      —— 我们这一侧成立（超限按名省略，条数/字符数可统计）；内核仍当普通正文。

## 注意

契约改动**只增不改**。四项不必一次做完，但 1 要先做 —— 它决定了后面三项的接线形状。
