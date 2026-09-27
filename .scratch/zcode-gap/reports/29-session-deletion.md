# Ticket 29-session-deletion — Final Report

Commits: (orchestrator commits this lane).
Attempts: 0 — orchestrator implemented directly (task-channel policy still in effect from tickets 13/16/17).

## 交付物

- `src/main/sessionDeletion.ts`（新）：`deleteSessionRecord(sessionId, file, deps)` — 删除顺序固定为 **dispose → unlink 转录 → terminal → registry 行 → dropRules**，除 dispose 外全部可失败步骤都在 registry 行删除之前（行是唯一指针，行先删 = 永久孤儿）。`kernelAlive` 在 dispose **调用之前**捕获（worker auto-restart 会让事后 `isAlive()` 说谎）。规则：
  - worker 活 + dispose 失败 → 抛 `SESSION_BUSY` 中止，什么都没动（文件仍在、行仍在、会话仍可用）；
  - worker 已死（`kernelAlive === false`）→ 无人持有，按成功继续；
  - `unshare` 由 `registry.sharedTranscriptOwners(file, exceptId)` 判定：有别的行指向同一文件 → `shared-kept`，删行不删文件；`already-gone`/`none` 幂等放行；unlink 其它错误 → 中止（行完好）。
  - `rollbackRowTranscript(file, retiringId, io)`：create/fork 回滚路径专用——指针行已不在或文件被共享则跳过，仍指向则删文件；删除失败只 warn 不抛（回滚不能中止）。
  - `fsTranscriptIo()`：真盘实现（`existsSync`/`unlinkSync`），deps 注入使顺序与失败分支全部可单测。
- `src/main/kernel.ts`：`KernelHost.isAlive()`（worker 重启后 session 不可复活，用 channel 在线判持有，doc 注明捕获时机契约）。
- `src/main/registry.ts`：`sharedTranscriptOwners(file, exceptId)`。
- `src/main/ipc.ts`：`deleteSession` 重写为经 `deleteSessionRecord`；create/fork 的失败回滚（`registry.remove` 后）接入 `rollbackRowTranscript`；`transcriptIo` 在 `registerIpcHandlers` 顶部构造一次注入。
- `tests/sessionDeletion.test.ts`（13 项）：顺序断言 `['dispose','unlink','terminal','row','rules']`、SESSION_BUSY 中止零副作用、worker 死放行、shared-kept、already-gone、no-file、unlink 抛错行不动、回滚 4 变体、真 FS 删除、真 FS 删父留子（`header.parentSession` 仍在）。
- `docs/session-deletion.md`：删除到底删了什么、顺序即安全属性、共享转录、分叉血缘、硬删除无撤销的理由、回滚跟指针、已知残余（worker 在产生指针前死掉的孤儿 main 不可见）。
- `scripts/diag-delete-session.mjs`（新）：两相真机走查（stage/verify），29 专属验收。
- `scripts/diag-session-fork.mjs`：click teardown 与 drop 阶段补 29 证据检查（先 check 文件已随删除消失，rmSync 降级为失败兜底）。

## 验收

| # | 项 | 状态 | 证据 |
| - | -- | -- | -- |
| 1 | 删除会话后转录文件不在盘上（走查证据） | ✅ | 真机 `stage` 8/8：`删除 F1：转录文件随行一起消失（29 核心断言）`；`verify` 9/9：`删除 F2：转录文件随行一起消失`；fork 脚本 `click` 22/22（修改后）：`清理：删除会话带走了转录文件（29）` |
| 2 | dispose 失败注入：文件仍在且会话可用 | ✅ | 单测：worker 活 + dispose 失败 → 抛 `SESSION_BUSY`，断言顺序里没有 unlink、文件 mock 未被碰、行/终端/规则均未动 |
| 3 | 删父后分叉子仍冷加载 | ✅ | 真机：stage 里 F2 fork 自 F1、删 F1；重启后 `verify`：`F2 冷加载带回了历史消息 — 46 messages`，且 `SOURCE 转录全程字节未变`、`会话总数回到基线 86 → 86`；单测层另有删父留子 + `header.parentSession` 断言 |
| 4 | 全库搜索无其它孤儿点 | ✅ | `registry.remove` 全库仅 3 处（create 回滚、fork 回滚、deleteSession），三处均已接线；pluginMarketplace/plugins 的 remove 属 PluginRegistry 无转录；结论落 `docs/session-deletion.md` |
| 5 | 边界与保留策略落档 docs/ | ✅ | `docs/session-deletion.md`：删除清单、顺序安全性、共享/回滚/血缘/硬删无撤销/已知残余 |

## 门禁

- `npm run check`：lint 0 / tsc×3 0 / **241/241**（228 基线 + 本票 13）
- `node --check scripts/diag-session-fork.mjs`：0；两脚本真机实跑全 PASS

## 真机走查原始记录（2026-09-27）

```
stage  8/8    SOURCE→F1→F2，删 F1：行/文件同删，F2 行文件俱在，SOURCE 字节未变
（重启应用）
verify 9/9    F1 不复活；F2 冷加载 46 messages；删 F2 文件同删；86 → 86 基线
click  22/22  改后的 fork 脚本 UI 路径：删除前文件在、删除后文件消失、清扫为零
```

## 诚实缺口

- **硬删除无撤销**：不建回收站（半吊子 UI 更糟）；已落档为决策而非遗漏。
- **worker 在写出指针前死掉**的孤儿文件 main 不可见（唯一遗留残余，文档已记录）。
- dispose 失败注入只在单测层复现（真机注入需破坏 worker channel，收益低）；真机层其余四箱全绿。
