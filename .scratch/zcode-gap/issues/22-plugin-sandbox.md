# 22: 插件 / hooks 沙箱（安全路线图 P2 大件）

**What to build:** 插件扩展代码与 hook 脚本从内核进程隔离出去，在受控子进程中执行，失败与超时不拖垮会话。执行具备能力边界：文件访问限制在工作区与插件数据目录、环境变量最小化注入、网络访问可声明可审计（当前是 `shell:true` + 全环境变量的裸执行）。市场安装的插件默认最小权限，启用时向用户展示其请求的能力并可拒绝。执行失败、超时、越界尝试全部进可观测诊断。现有插件/hook 有迁移路径，工单 13/14 的事件契约不变（只是执行位置变化）。

**Blocked by:** 14 (Hooks 扩展②：Stop block 续跑 + PermissionRequest 自动决策)

**Status:** done（`953e410`）

- [x] 插件扩展与 hooks 在隔离子进程执行；子进程崩溃/超时不影响内核与会话
- [x] 能力边界生效：越界文件访问/环境变量读取被拒，有演示用例
- [x] 市场插件默认最小权限；启用时展示能力请求，可拒绝
- [x] 越界与失败进诊断日志，可观测（诊断脚本可查）
- [x] 工单 13/14 的事件语义回归全绿（协议不变、执行位置变）
- [x] 存量插件迁移说明落档，示例插件在沙箱下正常工作

## 落库内容

- `src/main/sandbox.ts`：策略（来源基线 / 环境白名单 / cwd / roots / 授权读写）。
- `hooks/hookRunner.ts`：`capabilities` 缺失 = 存量行为（继承全环境），存在 = 拒绝越权声明（`sandbox_denied`）+ 越界可执行文件（`sandbox_boundary`）+ 白名单环境 + 受限 cwd。
- `pluginBridge` / `pluginRegistry` / `hookSources` / `pluginManifest`：声明从 `plugin.json` 或 `hooks.json` 传到执行点。
- 授权：`codex:setPluginCapabilities`、`PluginCapabilityView`、详情面板 Grant/Revoke；卸载自动撤销。
- `docs/plugin-sandbox.md`：能力表、强制/非强制边界、迁移说明。

## 未闭环 / 如实记录

- **进程启动后的文件访问拦不住**（Windows 无 job object / AppContainer）。环境、cwd、是否启动三者是本进程强制的；越过之后是声明的。文档写明，不粉饰。
- 越界检查只覆盖 `type: 'process'` 的命令行里**落在工作区内**的路径：解释器本身（node.exe）在系统目录，若按"程序必须在沙箱内"判会误杀所有 hook。
- 示例插件（examples/hooks，`type: "command"` + `node`）在沙箱下按代码路径成立（`PATH` 在白名单、cwd = 工作区），**未跑真机人工回归**。
- 验证在 worktree（`D:\2026\.tmp-sandbox`）：typecheck 三份配置全绿、221/221 单测、build 绿；其中 1 条真实 spawn 子进程，断言父进程里的 secret 子进程看不到、cwd 落在插件数据目录。
