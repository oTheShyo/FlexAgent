# 29: 删除会话留下孤儿转录文件

**What to build:** `deleteSession` 目前删掉了内核会话、终端、权限规则和注册表行，**唯独把 PI 转录文件（`~/.pi/agent/sessions/**/*.jsonl`，含完整对话内容）留在盘上**。而 `registry.remove(sessionId)` 恰好是那个文件唯一的指针——删完就再也找不到它，也没人会来清。要做的是一次删除把这份数据一起清掉（或明确给出保留策略与回收入口），并把边界写清楚：正在被别的会话引用的文件、以及 dispose 失败的文件，各自怎么办。

**Blocked by:** 12（会话重命名/归档后端，删除语义已在那里），17（分叉，`parentSession` 血缘会指向被删文件）

**Status:** done

## 发现过程

工单 17 的端到端走查里，脚本删掉临时分叉会话后统计残余文件，发现 `.fork-<id8>.jsonl` 仍在。核对 `src/main/ipc.ts:383-402`：

```
registry.require(sessionId)
await kernel.request({ type: 'disposeSession', sessionId })   // best-effort，失败被吞
terminals.disposeSession(sessionId)
registry.remove(sessionId)                                    // ← 唯一指针在这里消失
await dropRulesForSession(sessionId)                          // 连权限规则都清了
```

同期清理的三样东西（内核会话、终端、权限规则）说明这不是"故意保留"，而是漏了文件这一样。

## 影响

- **数据留存**：用户点"删除会话"后，完整对话（含工具输出、可能的路径与片段）永久留在磁盘，且不受任何 UI 控制。真实量级可参考本机：`--C--Users-HP-.flexagent-scratch--` 目录下单条转录 20 KB–180 KB，该注册表已有 86 条会话。
- **不可达增长**：文件没有第二个索引，删除即孤儿，只有人工翻目录才能发现。
- 与 17 的交互：分叉子会话的 `header.parentSession` 指向父的 PI id。删父留子时血缘指向一个不存在的文件——需要决定是允许（血缘只是标注）还是连带处理。

## 边界（动手前先想清楚，别只看"删文件"）

1. **dispose 失败**：现在 `catch {}` 吞掉了错误。若内核仍持有该文件，先删文件可能把活着的会话抽掉——要么 dispose 成功才删，要么删之前确认没有任何 host 持有它。
2. **被引用的文件**：确认没有别的 registry 记录指向同一路径（例如同一 PI 文件被两条记录 attach 过）。
3. **分叉血缘**：删父不删子时，子会话能否照常冷加载（17 的走查表明子文件是自包含的，但没专门测"父文件已不存在"这条）。
4. **撤销**：现在删除没有 undo。若考虑保留策略（回收站式），要连同 UI 一起设计，别只做半边的"延迟删除"。

## 验收

- [x] 删除会话后，其 PI 转录文件确实不在盘上（有走查证据）— 真机 `scripts/diag-delete-session.mjs stage` 8/8 + `verify` 9/9 + `diag-session-fork.mjs click` 22/22，三处均实测"文件随行一起消失"
- [x] dispose 失败时不误删：给出可复现的失败注入，断言文件仍在且会话仍可用 — `tests/sessionDeletion.test.ts`：worker 活 + dispose 失败 → `SESSION_BUSY`，断言零副作用（未 unlink、行/终端/规则未动）
- [x] 删除父会话后，已存在的分叉子会话仍能冷加载 — 真机删 F1（F2 之父）后重启，`verify`：F2 冷加载带回 46 条消息；单测层删父留子 + `header.parentSession` 断言
- [x] 全库搜索：除删除路径外，没有别的地方因为缺指针而留下孤儿转录（含分叉文件）— `registry.remove` 全库仅 3 处且全部接线 `rollbackRowTranscript`/`deleteSessionRecord`，见 `docs/session-deletion.md`
- [x] 边界与保留策略落档（`docs/`），说清楚"删除到底删了什么" — `docs/session-deletion.md`

## 复现

```bash
# 应用在跑的前提下（scripts/diag-session-fork.mjs 的四阶段走查会顺手暴露这一点）
node scripts/diag-session-fork.mjs click   # 末尾的 teardown 会把残留文件打出来
```
