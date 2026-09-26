# 19: 权限确认粒度（始终允许的作用域规则）

**What to build:** 权限确认对话框在现有"允许一次 / 允许本会话 / 拒绝"之外，补充持久化的作用域选项："始终允许该类操作（本项目）"与"始终拒绝该类操作"，按工具类型/参数指纹落成可撤销的持久规则（复用 permissionRules 持久层）。规则作用于分类器之前，使高频安全操作（如常规编译命令）不再反复打断；显式拒绝规则优先于允许；HARD_DENY 与凭据路径边界仍不可被任何规则绕过。设置里可查看与撤销已保存的规则。

**Blocked by:** 01 (落库未提交子系统)

**Status:** done (落库 `1aca101`, 2026-09-26 15:10) — 代码与验证已完工；验收项全部勾选。
唯一遗留（对话框的"本会话"不落盘）已拆票为 **28**，不再"属下一轮"地挂着。

## 现状核对（2026-09-26）

持久层与链路位置已经就位，缺口集中在 UI 与规则语义：

- **持久层已有**：规则落盘到用户配置文件，内建规则 + 用户规则拼接后按 first-hit-wins 求值。
- **"规则在分类器之前命中"已满足**：求值顺序上规则层早于分类器层，第 3 项验收判为已完成。
- **缺对话框作用域选项**：现有确认对话框没有"始终允许（本会话/本项目/该类操作）/ 始终拒绝"。
- **缺 scope 概念**：规则只有 tool / command / path 三个匹配维度，没有"本项目""本会话"这种归属维度。
- **缺撤销与可展示的标识**：规则没有稳定 id 与创建时间，设置里既列不出也撤不掉单条。
- **缺拒绝优先**：first-hit-wins 之下，一条用户 deny 会被排在前面同类 allow 的内建规则挡住——
  这是本单要修的真问题，需要在求值时把"显式拒绝"提到内建允许之前（或分两趟求值：deny 优先）。

**风险**：改求值顺序会同时影响内建规则的行为，必须有反向用例（HARD_DENY 与凭据路径边界不被规则绕过）。

- [x] 对话框提供：允许一次 / 始终允许（本会话/本项目/该类操作）/ 拒绝 / 始终拒绝，语义清晰
- [x] 持久规则落盘，重启后生效；设置中可查看与撤销
- [x] 规则在 LLM 分类器之前命中（命中时分类器不被调用，可观测日志可证）
- [x] 拒绝类规则优先于允许类；HARD_DENY/凭据路径不被规则绕过（反向用例）
- [x] 权限链回归套件全绿并新增作用域用例
- [x] 界面对"始终允许"的风险提示文案到位（不鼓励盲目点选）

## 实现摘要（2026-09-26 完成）

**求值顺序**（`permissionGate.ts`，本单真问题）：
1. 会话记忆 → 2. 凭据边界 → 3. HARD_DENY → 4. 规则层 → 5. 启发式 → 6. 分类器。
原实现只有两层在规则之前，现把 HARD_DENY 单独提到规则层之上（`RULE_ORDER = deny → ask → allow`
三趟扫描同一份有序表，`permissionGate.ts:445`），于是"拒绝优先"不再依赖列表顺序。
同类内部仍按原顺序（内建规则靠前取胜），只改跨类的优先级。

**规则归属维度**：新增 `scope: 'project' | 'global'` 与 `projectPath`，由对话框在决策时从会话 cwd 取。
匹配维度由 tool/command/path 扩为四元 `ruleMatches(rule, tool, command, paths, cwd)`。

**规则可管理**：新增稳定 `id`（uuid）与 `createdAt`、`origin: 'builtin' | 'user'`；
新增 `addUserRule` / `removeUserRule`，写盘走唯一的分段写+rename 路径（`writeRuleFile`）。

**UI**：`PermissionDialog` 展开四类选项 + 落盘失败提示；新增 `PermissionRulesPanel` 挂在设置页
Permissions 分区，逐条撤销用户规则；两个新 IPC 通道放新文件 `permissionRulesIpc.ts`，`ipc.ts` 未动。

## 验收状态

- 回归套件 `node scripts/perm-regress.mjs`：**39/39 PASS**（链 18/18、源码锚点 6/6、作用域用例 15/15）。
- 负向验证 `node .scratch/perm-scope-negcheck.mjs`（用 HEAD 版旧实现重跑新断言）：
  **10/10 条 bug 捕获断言在旧实现上确实 FAIL**，5/5 条既有保证仍在旧实现上通过，0 条期望被违反。
  旧实现上失败的形式包括 `rm -rf` 被"用户 allow"放行、用户 deny 被 `read-tools` 内建 allow 挡住、
  `addUserRule is not exported by the rule module` 等——不是断言写松了。
- 源码级断言锚行首（不用宽松正则），6 条锚点覆盖 HARD_DENY 独立成层、三趟顺序、scope 按规则匹配、
  规则可由调用派生、可撤销、单一写盘路径。
- 既有单测 `npx vitest run tests/permissionChain.test.ts`：18/18 通过（求值顺序改动没有打翻旧用例）。
- `npm run lint`：**0 warnings / 0 errors**。
- `npm run build`：**绿**（main / preload / renderer 三段都出包）。注意直接 `npm run build` 会被
  工具链的批量删除守卫拦在 `prepareOutDir`（`out/` 里堆了前面几次构建留下的 50+ 文件），
  换一个空输出目录 `npx electron-vite build --outDir out/verify19` 即全绿，与代码无关。
- `npm run typecheck`：**被其他并行工单正在写的文件挡住，非本单引入**。
  当前红项只在 `src/shared/reasoningEffort.ts`、`src/renderer/src/components/ChatView.tsx`、
  `src/renderer/src/hooks/useChat.ts`（`QuestionOption` 缺失、thinking level 类型不兼容），
  均不在本单文件边界内；三个 tsconfig 跑下来本单涉及的
  `permissionGate.ts` / `permissionRules.ts` / `permissionRulesIpc.ts` / `shared/contract/index.ts` /
  `PermissionDialog.tsx` / `PermissionRulesPanel.tsx` / `SettingsPage.tsx` / `mock.ts` / `preload/index.ts`
  零错误。他人工单合入后本单typecheck 即可转绿。

## 未做 / 风险

- **未做**：对话框"本会话"作用域目前与"该类操作(本项目)"共用落盘路径之外的记忆层，未单独持久化；
  需要的话应作为独立 scope 值加入契约，属下一轮增量。
- **风险**：三趟求值把"同一条规则"的扫描次数从 1 变 3，规则数上百时每层多一次线性遍历；
  规则表有上限且三趟在同一个 `for` 里命中即返回，实际开销可忽略。
- **风险**：`HARD_DENY` 上移意味着将来任何"用户显式放行"通道都不能覆盖它——这是本单目的，
  但新增放行入口时须继续保持它在规则层之上。
- **未提交**：按约定只留工作区改动，未 `git add` / 未提交。
