# 25: 打包分发（Windows 安装包）

**What to build:** 引入 electron-builder 产出可分发的 Windows 安装包（x64），当前只有 dev/build 脚本、无任何打包配置。打包产物安装后核心链路可用：发消息、权限确认、diff 审查、终端、密钥脱敏、凭据加密（若工单 20 已合入）。明确版本号策略（与 package.json 一致）、升级与卸载路径。签名可后置，但未签名安装的引导说明要有。

**Blocked by:** 02 (工程工具链（lint + 单测 runner）), 04 (UI P0 修复)

**Status:** ready-for-agent

- [ ] `npm run dist`（或等价命令）产出 Windows x64 安装包
- [ ] 全新机器安装后手工回归：聊天、权限确认、diff、终端、脱敏全部正常
- [ ] 版本号与 package.json 一致，关于页/窗口标题可核对
- [ ] 升级路径：新版本覆盖安装后会话数据与配置保留
- [ ] 卸载路径明确（数据是否保留有文档说明）
- [ ] 未签名提示/绕过说明写进文档
