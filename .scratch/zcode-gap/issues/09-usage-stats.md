# 09: 使用统计页（token / 模型 / callSource 聚合）

**What to build:** 新增一个使用统计视图，从已有的离线 JSONL 观测数据（LLM 调用日志 + 事件日志）聚合展示：token 消耗按模型分布、按 callSource 分布（chat / compaction / permission_classifier / memory_dedupe / role_task——让"开了 Memory 或权限分类器多花了多少"直接可见）、工具调用计数、按会话/时间的趋势。纯离线聚合，不引入新上报通道；空数据有友好空态。对应 ZCode 的"使用统计"能力。

**Blocked by:** 01 (落库未提交子系统)

**Status:** done

- [x] 视图入口可达，展示：按模型的 token 聚合、按 callSource 的 token 聚合、工具调用计数
- [x] Memory 自动提取、权限分类器等辅助调用的开销单独成列/可筛选
- [x] 至少一个趋势维度（按会话或按天）
- [x] 数据完全来自现有 JSONL 的离线聚合，不新增运行时上报
- [x] 无数据时展示引导空态而非报错
- [x] 聚合逻辑有单测（喂样例 JSONL 行验证统计正确）

## 交付记录

- 新增 `src/main/usageStats.ts`：`parseJsonl` / `aggregateLlmCalls` / `aggregateToolCalls` / `buildUsageStats`（纯函数，喂字符串）/ `collectUsageStats`（读盘）。
- 契约只增：`GlobalUsageBucket`（复用既有 `UsageBucket` + `total`/`failed`）、`GlobalUsageStats`、`getUsageStats`、IPC `codex:getUsageStats`。
- UI：Settings 新增 **Usage** 分区（`UsageStatsPanel`）：Totals 卡 + 按 callSource（含 Bash classifier / Memory extraction / Sub-agents 等的中文式说明）/ 按模型 / 最忙工具 / 按天；空数据走引导空态。
- 单测 `tests/usage-stats.test.ts` 10/10（含坏行跳过、缓存 token 计入、非 LLM 的 pipeline 行不计、按天排序、session 去重）。
- 未做：真机观感（本机 Electron 未起）；`npm run test` 脚本属于 02 工单，未加。
