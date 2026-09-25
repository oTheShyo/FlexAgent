# Ticket 04-ui-p0-fixes — Final Report

Source: `.impeccable/critique/2026-09-25T04-56-16Z__src-renderer-src.md` P0/P1 list.
Commits: `b79d7c2` (interaction), `13686d8` (contrast/legibility).

## P0/P1 对照（critique 条目 → 处置）

| 条目 | 处置 | 说明 |
| -- | -- | -- |
| P0-1 终端抽屉遮挡 composer | ✅ 已核验（进场前已修） | 结构证明：`TerminalDrawer` 根为 `flex h-72 shrink-0`，无 `fixed`/`z-40`，与 composer 重叠在 CSS 上不可能 |
| P0-2 review 遮罩 Accept 死锁 | ✅ 已核验（进场前已修） | 自动打开于 diff 末尾 + badge；DiffPanel 新增显式 Dismiss 路径 |
| P1 顶栏层级/作用域 | ✅ 已核验（进场前已修） | — |
| 命令面板 focus ring / aria | ✅ 已核验（进场前已修） | — |
| App 层 Escape→deny 兜底 / Tab 陷阱 / autoFocus | ✅ 已核验（进场前已修） | — |
| 权限对话框焦点管理 | ✅ 本票修复 | 焦点捕获/归还 effect；Escape 分支触发 deny 并还焦点给触发元素；`<pre tabIndex>` 可聚焦 |
| diff 审查错误不可见/不可关 | ✅ 本票修复 | 错误 sticky + `role`/`aria-live` + Dismiss 按钮 |
| 首轮失败无重试路径 | ✅ 本票修复 | `canRetryError`/`onErrorRetry` 从 App 穿透 ChatView（内核未产出用户消息时无文本可重发——Copy details + composer 仍是出口，已知边界） |
| 对比度 < AA | ✅ 本票修复 | 4 个 token（light/eye-care `--text-muted`，meadow/mist `--text-subtle`）；对比度脚本 5 主题全 PASS ≥4.5:1，`--ring` ≥3:1 |
| 12px 字号下限（本票范围） | ✅ 本票修复 | ErrorBoundary/TopBar/Composer/CommandPalette/ConnectionBanner 共 15 处 10/11px→12px |

## 门禁

- `npm run check`（lint + typecheck×3 + vitest）→ **GREEN exit 0**（完成时点，含当时全部并行会话改动）
- oxlint --deny-warnings：PASS（两次）
- LSP：本票 10 个文件 0 错误

## 诚实缺口（未做/不在范围）

- **CDP 视觉/手工回归未执行**（工单验收第 6 项未勾）：以结构证明 + 门禁 + 对比度脚本替代。
- 12px 下限未推到全站：Composer 模型菜单 10px 标签属模型选择器车道、ToolCard/Sidebar 等不在 P0/P1 范围（批量重排被工单禁止）。
- P2（favicon/bundle 性能）、P3 清理、"Reject 即回滚"、roving tabindex —— 不在本票范围，未修。
- 共享文件搭载：`App.tsx`/`PermissionDialog.tsx`/`Composer.tsx` 含并行会话的 question/references/remember hunks，各自由其车道提交。
