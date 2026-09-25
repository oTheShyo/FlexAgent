# 15: Memory 自动提取管线

**What to build:** 对齐 ZCode 的 Memory：每轮对话成功结束后，后台自动回顾最近交流，判断是否有值得长期保留的内容，命中才写成精炼的记忆卡并更新索引（无命中零成本）。聚焦四类事实：用户偏好、对 Agent 工作方式的纠正、项目目标与约束、用户提供的外部资料；刻意不记代码结构/Git 历史（随时可重读）、项目指令文件已有内容、仅当轮有效的临时信息。与现有 memory_manage 主动写入并存，复用去重（memoryDedupe）与卡片 lint；注入沿用现有预算上限。整个流程在回合结束后跑，不拖慢回复。功能默认关闭，设置可开；只对新会话生效（对齐 ZCode 语义）。

**Blocked by:** 01 (落库未提交子系统)

**Status:** done

- [x] 开关存在（默认关），开启后新会话生效，进行中会话不受影响
- [x] 每轮成功结束后触发后台提取；无值得保留内容时不写任何东西
- [x] 写入的记忆卡属四类之一，卡格式与现有 memoryStore 兼容，索引更新
- [x] 去重生效：与既有记忆语义重复的不重复落卡
- [x] 提取请求计入可观测统计（callSource 归因可见，使用统计页能算出开销）
- [x] 主回复延迟不受影响（后台执行，有测量或论证记录）
- [x] 后台失败只记诊断，不影响会话

## 交付记录

- 新增 `src/main/skills/memoryExtract.ts`：四类事实的提取 prompt、严格 JSON 解析（`parseExtractReply`，半截卡片比没有卡片更糟）、本地去重 + judge 去重、失败只记诊断。
- 开关：Settings → General → Memory「Remember facts automatically」，**默认关**；存 `~/.flexagent/settings.json` 的 `memory.autoExtract`；**在会话创建时读取并固化**，进行中会话不受影响。
- 触发：assistant `message_end`（非 error）后**不 await** 地后台跑；`extractingMemory` 是闩锁不是队列。主回复延迟不受影响：回答已在触发前 emit。
- 归因：新增 `CallSource = 'memory_extract'`，落 llm-calls.jsonl，Usage 页可见开销。
- 与 `memory_manage` 并存；写入走同一个 `addMemoryCard`（复用 lint），scope 用会话 cwd。
