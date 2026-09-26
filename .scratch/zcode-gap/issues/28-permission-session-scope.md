# 28: 「本会话始终允许」做成可撤销的持久规则

**What to build:** 把权限对话框里的"允许本会话"从会话记忆升级成一条真正的持久规则：带稳定 id、
带创建时间、可在设置面板里逐条查看与撤销，且**在会话结束后不再生效**。

**Blocked by:** 19（作用域规则已 done 并落库 `1aca101`）

**Status:** done — 落库 `b35f607`，2026-09-26 16:55

## 选了路 1（求值时比对 sessionId），理由

`GateOptions` **本来就有 `sessionId`**（`permissionGate.ts:460`），所以这条路不需要给任何链路加参数
（工单里担心的那件事不存在）。但选它的真正理由是失败模式：

- **路 2（退出时清理）** 的正确性依赖"清理从不遗漏"：dispose / delete / 崩溃 / 旧版本写下的规则文件，
  漏一次就留下一条**永久生效的宽泛规则** —— 这是最坏结果。
- **路 1（比对）** 漏一次只是文件里多一行永不匹配的死规则，无害。
  而且"另开一个会话不命中"这条验收是它免费带来的。

清理仍然做了（deleteSession → `dropRulesForSession`），但定位是卫生，不是安全依赖。

## 现状（别重复调研）

`PermissionDialog.tsx` 的"Allow session"走 `scope === undefined` 分支 —— 不建规则，只写会话记忆
（`PermissionDialog.tsx:66-77`）。后果：

- 设置面板列不出它（没有 id），所以**撤不掉**，只能等会话结束。
- 重启后失效，但用户点它时的心智模型是"我授权了"，与"始终允许·本项目"看起来没有区别。

19 已经把作用域（`global` / `project`）、稳定 id、`createdAt`、`origin` 和撤销通道全部做好了，
本票只是补上 `session` 这一档。

## 难点（想清楚再动手）

一个 `session` 作用域的规则，**会话结束后必须失效**，否则它会随 `permissions.json` 永久留存，
变成一条指向已不存在会话的僵尸规则。两条路：

1. 规则带 `sessionId`，求值时比对当前会话 —— 需要 gate 拿得到 sessionId（要看现有 `GateRequest` 有没有）。
2. 会话结束（dispose / 归档）时清理该会话的规则 —— 需要一个清理时机，漏一次就留一条僵尸。

**选哪条要在工单里写明理由**，别默认选简单的那条。

## 验收

- [x] 「允许本会话」产生一条持久规则：有 id、有 `createdAt`、origin 为 `user`
      —— 复用 19 的 `derivedRule`；`scope: 'session'` 额外落 `sessionId`
- [x] 设置面板能看到它，并能逐条撤销
      —— `SCOPE_LABEL` 加 `session: 'this chat, until it ends'`；撤销走既有 `removeUserRule`
- [x] 该规则**只在本会话生效**：另开一个会话，同样的调用不命中
      —— 两条配对断言（同一条规则，两个 sessionId，结果相反）
- [x] 会话结束后不残留僵尸规则 —— 走**路 1**，理由见上；另加 `dropRulesForSession` 做卫生清理
- [x] 拒绝优先的求值顺序不受影响 —— 44/44（含 19 的三趟断言）
- [x] HARD_DENY 与凭据路径边界仍然不可被规则绕过
      —— 新增「session 规则不能重新授权 `rm -rf`」；negcheck 显示它在 19 之前是 `allow`
- [x] 新断言做负向验证：退回 19 的实现必须 FAIL
      —— 旧实现下 13/13 bug-catching FAIL、6/6 既有保证 PASS、0 条期望被违反

## 边界

契约**只增不改**。若 `GateRequest` 拿不到 sessionId，先查求值链路上有没有现成的，
不要为了这一档给整条链路加参数。
