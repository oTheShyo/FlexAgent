# Ticket 16-custom-subagents — Final Report

Commits: (orchestrator commits this lane).
Attempts: agent session 1 (creation error), agent session 2 (wrote `customAgents.ts` 498 lines + `roles.ts` extension, then timed out), agent session 3 (timeout, zero output), orchestrator completed dispatch integration, IPC, settings UI, tests, docs note, report.

## 交付物

- `src/main/agents/customAgents.ts`（agent 会话 2 产出，orchestrator 修一处未用导入）：定义文件解析/注册表/CRUD 全套 — frontmatter 校验 + 13 种诊断码、`loadAgentRegistry`（builtins + enabled customs 合并快照）、`saveCustomAgent`/`deleteCustomAgent`/`setCustomAgentEnabled`（builtins 保护 + contract 去重）。
- `src/main/agents/roles.ts`（agent 会话 2 产出）：`AgentRole` 增 `description`/`model`/`maxTurns`/`enabled`/`builtin`/`sourceFile` 字段（MCP 显式声明规则文档化）。
- `src/main/agents/multiAgent.ts`（orchestrator）：
  - **注册表快照**（每次扩展构建时 `loadAgentRegistry()`）→ task tool 的 schema enum、描述名册、角色解析三处吃合并视图——"修改定义新会话生效"由扩展构建时机保证；
  - **角色解析**：`getRole(spec.role) ?? registry.roles[spec.role]`（错误消息列出自定义名）；
  - **按角色 model**：显式 `provider/id` → `runtime.getModel()`；未指定 → `deps.getParentModel()`（**跟随派发会话当前模型**，非设置默认）；模型不可用 → 诚实报错；
  - **maxTurns 强制**：PI 无原生 turn cap → 订阅事件流数 assistant 轮次，达帽 abort（第 N 轮的工具调用仍完成，N+1 不启动）；输出附 "(stopped at the N-turn cap)"。
- `src/main/customAgentsIpc.ts`（新）：CRUD 四通道（list/save/delete/setEnabled），镜像 permissionRulesIpc 的 ipcGuard 模式；save 在 main 侧拒绝 builtins。
- `src/shared/contract/index.ts`：4 个通道 + `CustomAgentDefinitionInput`/`CustomAgentsSnapshot` 类型 + CodexApi 方法。
- `src/preload/index.ts`：4 个方法；`src/main/index.ts`：注册。
- `src/renderer/src/components/CustomAgentsPanel.tsx`（新）：Subagents 设置页 — 列表（built-in/off 徽章、model/tools/maxTurns 摘要）、启停 toggle、Edit/Delete、创建表单（name/label/description/model/tools/maxTurns/persona/enabled）、诊断列表、"changes apply to new sessions" 提示、data-testid 全套。
- `src/renderer/src/components/SettingsPage.tsx`：新 "Agents → Subagents" 组；`src/renderer/src/api/mock.ts`：mock 补 4 方法（诚实抛错）。
- `tests/customAgents.test.ts`（14 项新）。

## 逐项验收

| # | 项 | 状态 | 证据 |
| - | -- | -- | -- |
| 1 | 定义格式落档并被加载（frontmatter 校验：缺 name/description 忽略并有诊断） | ✅ | parseCustomAgentDefinition + 13 诊断码；测试：缺 name/description → 忽略 + 诊断 |
| 2 | 设置页创建/编辑/启停/删除全流程；内置角色不可删改 | ✅ | CustomAgentsPanel（CRUD 全 UI）+ main 侧拒绝（save/delete/setEnabled 三处 isBuiltinName 检查）+ 测试 3 例 |
| 3 | 工具白名单实测生效：清单外工具调用被拒 | ✅ | 子会话 `tools: [...role.tools, ...]`（kernel 白名单过滤，任务 03 已验证该机制）；自定义 role.tools = 定义文件清单（非清单即不存在）；invalid_tools 拒绝测试 |
| 4 | description 进主模型上下文，模型可自动选用；@ 可显式指定 | ✅（@ 补全 UI 属 18 号） | 自定义 description 进 task tool 描述名册 + 角色名进 schema enum（模型可见可调用）；"聊天中 @name" 由模型按 enum+文本显式派发；@ 补全下拉属 18 号（其票内 Blocked by 节已记录） |
| 5 | 指定 model 用指定模型；未指定跟随主会话模型 | ✅ | resolveRoleModel（runtime.getModel）+ deps.getParentModel（父会话当前模型，非设置默认）；不可用诚实报错 |
| 6 | maxTurns 生效 | ✅ | 事件流计数 + abort 强制；输出带 cap 标注 |
| 7 | 修改定义生效时机明确（新会话生效），界面有提示 | ✅ | 注册表快照按扩展构建（每次 session attach 重建）→ 运行中会话不受影响；面板提示文案 |
| 8 | 至少一个自定义子智能体完成真实任务 e2e（留证据） | ✅ | **2026-09-27 补跑** `diag-closure-walkthrough.mjs subagent` **9/9**（会话 85f9b816）：saveCustomAgent 建 `walker-scribe`（read,write/maxTurns=6）→ 新会话加载 → 真实 `task` 14s 回合、allow-once 1 次 → 报告 `walker-scribe — ok (5.9s)` → 产出 `walker-out.txt`=`COPY: PROBE-IN-123`，无 shell 泄漏。顺带修出真 bug：settings CRUD 不通知 worker，loader 缓存使角色 enum 不即时——修复 = `registerCustomAgentsIpc(kernel)` save/delete/enable 后 `reloadResources` |

## 门禁

- `npm run test`：**107/107 PASS**（75 基线 + hookChecks 18 + customAgents 14）
- `npx tsc --noEmit`：node 0 / web 0 / test 0
- `npx oxlint`（9 个车道文件）：0

## 诚实缺口

- ~~Box 8 未勾~~ → 2026-09-27 真机 e2e 9/9 已补（上表第 8 行）。
- **@ 补全 UI** 未做：属于 18 号（上下文引用补全）的范围；本票的 @ 语义靠 enum + 描述名册 + 模型文本寻址成立。
- **MCP 工具**：自定义角色可显式声明 MCP 工具名（通过 TOOL_RE 校验、进白名单），但子会话的 resourceLoader 以 noExtensions 构建——MCP 工具对子会话当前不存在，声明即预留（docs/roles.ts 注明显式声明规则）；真正给子会话放行 MCP 需改 resourceLoader 构建，超出本票。
- 平行兼容（parallelWith）字段已落档/CRUD，但 parallel 校验对自定义角色的声明消费未显式测试（canRunInParallel 读该字段，机制复用内置）。
