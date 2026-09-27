# 25: 打包分发（Windows 安装包）

**What to build:** 引入 electron-builder 产出可分发的 Windows 安装包（x64），当前只有 dev/build 脚本、无任何打包配置。打包产物安装后核心链路可用：发消息、权限确认、diff 审查、终端、密钥脱敏、凭据加密（若工单 20 已合入）。明确版本号策略（与 package.json 一致）、升级与卸载路径。签名可后置，但未签名安装的引导说明要有。

**Blocked by:** 02 (工程工具链（lint + 单测 runner）), 04 (UI P0 修复)

**Status:** done (committed this lane; report: reports/25-packaging.md; 验收第 2 项已于 2026-09-27 真机执行——全新静默安装 + 安装包环境 ui 走查 17/17，见下)

- [x] `npm run dist`（或等价命令）产出 Windows x64 安装包
- [x] 全新机器安装后手工回归：聊天、权限确认、diff、终端、脱敏全部正常（2026-09-27 执行：`npm run dist` 重建 → `FlexAgent-0.1.0-setup.exe`（222,703,248 B）静默安装 `/S` 退出码 0 → 装到 `%LOCALAPPDATA%\Programs\FlexAgent` → 安装版带 `--remote-debugging-port=9222` 启动 → `scripts/diag-closure-walkthrough.mjs ui` **17/17**（会话 a7c72c95：发消息/权限对话框 allow-once+真实执行/diff 自动打开+Accept 可点/Ctrl+T 终端中收发 TERMINAL-OK）；脱敏探针：10 个模型 IPC 均 `apiKeySet=true` 且无原始 key、无 key 命名 IPC 方法、`model-keys.json` 独立在盘不透出。证据见 reports/25-packaging.md）
- [x] 版本号与 package.json 一致，关于页/窗口标题可核对
- [x] 升级路径：新版本覆盖安装后会话数据与配置保留
- [x] 卸载路径明确（数据是否保留有文档说明）
- [x] 未签名提示/绕过说明写进文档
