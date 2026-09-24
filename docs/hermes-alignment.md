# Hermes skill 系统与自进化机制 → FlexAgent 对齐分析

> 参考: [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)（README + 官方文档 Skills System 页），对照 FlexAgent `src/` 实测。

## 结论

| 维度 | Hermes | FlexAgent 现状 | 差距定性 |
|---|---|---|---|
| Skill 格式 | agentskills.io 标准，SKILL.md + frontmatter | 同标准（内核 PI 白送） | ✅ 已对齐 |
| Skill 来源 | 三层: project → local(`~/.hermes/skills`) → external；bundled/hub | **仅 plugin 打包**一种来源 | ❌ 缺用户级目录 |
| Skill UI | `/skills` 浏览、详情、pending 审批 | 无，PluginsPage 只列 component | ❌ 缺 |
| 运行时自写 skill | `skill_manage` 六动作 + batch 原子拒绝 + linter + 审批门 | **无** | ❌ 核心缺口 |
| 自进化触发 | system prompt 规则（lessons not logs + 3 触发时机） | 无 | ❌ 纯 prompt，零成本可抄 |
| 持久记忆 | Memory cards（MEMORY.md/USER.md）+ 周期性 nudge | 无 | ❌ |
| 跨会话回忆 | FTS5（含自研 CJK tokenizer）+ LLM 摘要 | 无 | ❌ |
| 用户建模 | Honcho 方法学 | 无 | 可后期 |

一句话: **skill 的"读"路径内核已经免费拿到，缺的是"写"路径（skill_manage + 审批门）和整套自进化闭环（记忆 + 跨会话搜索）。**

---

## 一、Hermes 机制拆解

### 1.1 Skill 系统

**格式**: SKILL.md = YAML frontmatter + 四段正文（When to Use / Procedure / Pitfalls / Verification）。frontmatter 关键字段:

| 字段 | 作用 |
|---|---|
| `name` / `description` / `version` | 基础元数据（description ≤60 字符） |
| `platforms` | 限定 OS，不兼容则从 prompt/列表/斜杠命令中隐藏 |
| `requires_toolsets` / `fallback_for_toolsets` | 条件激活（如内置 duckduckgo-search 在有 FIRECRAWL_API_KEY 时自动隐藏） |
| `metadata.hermes.config` | 非机密配置项声明，加载时自动注入上下文 |
| `required_environment_variables` | 缺 key 时本地安全询问，自动透传沙箱 |

**三级渐进披露**: L0 `skills_list()` 列表 ~3k tokens → L1 `skill_view(name)` 全文 → L2 `skill_view(name, path)` 参考文件。references/ 在被需要前零成本。

**来源与优先级**: project（`.hermes/skills/`、`.agents/skills/`，需显式 trust）→ local（`~/.hermes/skills/`）→ external_dirs。bundled 技能经 `.bundled_manifest` 哈希跟踪，**用户改过的更新永不覆盖**。

**运行时自写 `skill_manage`**（自进化的核心通道）:

| 动作 | 用途 |
|---|---|
| `create` | 新建 skill（完整 SKILL.md content） |
| `patch` | 定向 `old_string→new_string` 修改（首选，省 token） |
| `patch + content` | 全量重写 |
| `delete` | 移除 |
| `write_file` / `remove_file` | 维护 references/ 等支持文件 |

配套机制:
- **batch 原子拒绝**: 任一 op 槽位非法 → 整批不应用，错误指明文本应属哪个键。
- **advisory linter**（警告不阻断）: oversized-body（正文 >24k chars，会撑爆上下文）、references-sprawl（>60 个参考文件）、incident-log-shape。
- **写审批门** `skills.write_approval: true`: 所有写入暂存到 `~/.hermes/pending/skills/` 跨重启保留，`/skills diff|approve|reject` 人工把关。
- **安全网**: agent 创建的 skill 永远只写 `~/.hermes/skills/`，从不碰 project/external 目录。

**自改进触发**（system prompt 规则）: ① 找到值得复用的多步工作流 ② 踩坑后找到可行路径 ③ 用户纠正了它的做法。内容原则 **"Lessons, not logs"**——陷阱写成可泛化规则 + 一句"为什么"，事故叙述/PR 编号/日期不进 skill。

### 1.2 自进化机制

1. **Agent-curated memory**: MEMORY.md（事实）/ USER.md（用户档案）/ SOUL.md（人格）卡片 + **周期性 nudge** 推动自己持久化知识。
2. **跨会话回忆**: 会话全文 FTS5 检索 + LLM 摘要。自研 Rust native `cjk_unicode61` bigram tokenizer，带自愈（tokenizer 加载失败→drop triggers 留 breadcrumb→下次 optimize 重建）。
3. **skill 自写** = 程序性记忆（见上），与陈述性记忆（memory cards）互补。
4. **后台 self-improvement review**: 每轮后跑，建议或暂存 skill 变更；curator 做 consolidation。
5. **micro-compaction** + learning graph / star-map 可视化。

---

## 二、FlexAgent 现状（实测）

### Skill: 只有"读"路径，且仅一种来源

- Skill 只能作为 **plugin 组件**存在: `plugin.json` 的 `skills` 字段 → `collectSkills` 扫 SKILL.md 目录（`src/main/pluginManifest.ts:332-379`）→ `skillRoots` 进 `kernel-protocol.ts:76-77`。
- 注入内核: `worker.ts:794-802` 构造 `DefaultResourceLoader` 时传 `additionalSkillPaths: pluginResourceSpec.skillRoots`。
- 内核白送的能力（PI `@earendil-works/pi-coding-agent`，无需自研）:
  - agentskills.io 标准解析 + `disable-model-invocation`（`core/skills.d.ts`）
  - system prompt 注入（≈ Hermes L0）+ `/skill:name` 按需展开全文（≈ L1，`core/agent-session.d.ts:420-424`）
  - 默认还会扫 **cwd 项目 skills + agentDir 全局 skills**（`includeDefaults` 未关）——即用户级目录内核已支持，**只是 FlexAgent 没有暴露路径约定和 UI**
- UI: PluginsPage 只把 skill 当 plugin component 列出（`PluginDetailPanel.tsx`）；slash command 补全只来自 plugin `command` 组件，不含 skill（`api/mock.ts:737-750`，真实 api 同构）。

### 自进化: 空白

- 全 `src/` 无 memory / self-evolution / 会话检索实现（grep 零命中）。
- 无任何 agent 可写持久状态的工具（写文件走通用文件工具，无结构化沉淀）。

---

## 三、照抄清单（按性价比排序）

| # | 抄什么 | FlexAgent 落点 | 成本 |
|---|---|---|---|
| 1 | **自进化触发规则 + "Lessons, not logs"** | system prompt 追加段 | 极低，纯文本 |
| 2 | **`skill_manage` 工具**（六动作 + batch 原子拒绝 + 3 条 linter） | PI extension tool（`createPluginBridgeFactory` 已有工厂，`worker.ts:799-801`），写入 `~/.flexagent/skills/` | 中，纯 TS |
| 3 | **写审批门**（staging → diff → approve/reject） | 对接现有审批体系（accept_perm 通道已存在）；renderer 加 pending 列表 | 中 |
| 4 | **用户级 skills 目录 + UI** | 约定 `~/.flexagent/skills/`；PluginsPage 拆 Skills 页；注意 `resourceLoaders` 按 cwd 缓存（`worker.ts:783-810`），skill 目录变更需失效重载 | 中 |
| 5 | **Memory cards**（MEMORY.md/USER.md 注入 + nudge 规则） | PI context files / appendSystemPrompt 通道注入；与 FlexAgent 无关、属于产品级 memory | 中 |
| 6 | **跨会话搜索** | 主进程 SQLite FTS5；CJK 分词先降级 like/trigram（Hermes 的 Rust native 扩展不必抄），查询结果 + LLM 摘要 | 高 |
| 7 | `/learn` 知识库技能生成 | 依赖 #2 落地后做（大来源 → SKILL.md + 分章 references/） | 高 |
| 8 | Hub 安全扫描 / 信任等级 | 已有 marketplace，方向一致；可加 dangerous 模式扫描 + `--force` 语义 | 中 |

**不建议抄**: learning graph/star-map 可视化、Honcho 用户建模、七种终端后端——与 FlexAgent 桌面客户端定位不匹配或收益低。

### 落地顺序建议

**M1**（#1+#2）: prompt 规则 + skill_manage → agent 具备自写能力，闭环跑通。
**M2**（#3+#4）: 审批门 + Skills 页 → 人工把关 + 可见性。
**M3**（#5+#6）: memory cards + 会话检索 → 补齐陈述性记忆。

### 关键实现注意

- **contract 约束**: skill_manage 走 extension tool 不动 `src/shared/contract`；若 #4 要在 UI 列全局 skills，需新增 contract 字段（只增不改）。
- **写入边界**: agent 自写 skill 永远落 `~/.flexagent/skills/`，与 plugin 打包 skills 物理隔离（照抄 Hermes 的安全网）。
- **审批门与 FlexAgent 既有审批模型对齐**: 后台/无人值守来源一律强制 staging，前台按 `write_approval` 配置。
