# 08: 推理强度切换（thought level）

**What to build:** 模型选择器旁增加推理强度档位（低/高/最高），映射到各 provider 的 reasoning/thinking 参数。可选档位由当前模型的能力声明（ModelFacts）决定——模型不支持时入口禁用并说明原因。选择结果随请求发出，可在 LLM 调用观测日志（llm-calls.jsonl）中看到参数差异；切换对新请求生效并随会话配置持久。用户按任务难度在速度与质量间权衡：简单小改用低档，复杂架构/疑难排查用最高档。

**Blocked by:** 01 (落库未提交子系统)

**Status:** done (committed 03cb623 + Composer selector 13686d8; report: reports/08-reasoning-effort.md)

- [x] 档位选择器出现在模型选择处，可选档位随模型能力声明变化（不支持则禁用+提示）
- [x] 选择后请求体携带对应 reasoning 参数，llm-calls.jsonl 中可验证差异
- [x] 档位随会话配置持久，重开生效；新会话默认档有明确策略（记录在工单产出中）
- [x] OpenAI 风格与 Anthropic 风格自定义模型各自正确映射参数（无对应参数的 provider 优雅降级并提示）
- [x] 至少一个真实模型实测三档请求差异有据可查
