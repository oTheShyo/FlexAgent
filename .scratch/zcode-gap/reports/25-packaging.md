# Ticket 25-packaging — Final Report

Commits: (orchestrator commits this lane: package.json + package-lock.json + docs/packaging.md).
Attempts: agent session 1 (timed out waiting on detached npm install; install itself SUCCEEDED), agent session 2 (completed config + two dist builds; died before docs/report), orchestrator finished docs/report/smoke.

## 交付物

- `package.json`：`electron-builder ^26.15.3` devDependency + `"dist": "electron-vite build && electron-builder --win --x64"` + 完整 `build` 配置块（appId com.flexagent.desktop、NSIS x64 per-user、asarUnpack node-pty、files 收紧为 out/main|preload|renderer + resources + package.json）。
- `docs/packaging.md`：构建（含 npmmirror 镜像要求）、版本策略、安装、升级、卸载、未签名 SmartScreen 引导。

## 构建证据

- `dist/FlexAgent-0.1.0-setup.exe` **224,115,206 bytes**（unsigned）+ `.blockmap` + `win-unpacked/`（两轮构建：首轮 files 未收紧 → 收紧后重跑，均成功；8:23:13 完成）。
- GitHub 不可达环境必须设 `ELECTRON_MIRROR` + `ELECTRON_BUILDER_BINARIES_MIRROR`（npmmirror）——已写进 docs。

## 逐项验收

| # | 项 | 状态 | 证据 |
| - | -- | -- | -- |
| 1 | `npm run dist` 产出 x64 安装包 | ✅ | setup.exe 224MB + blockmap + win-unpacked（上表） |
| 2 | 全新机器安装后手工回归 | ❌ 未执行 | **已做**：打包版启动冒烟（win-unpacked/FlexAgent.exe 存活 8s、233MB 工作集、干净退出，asar/资源加载无崩溃）。**未做**：GUI 聊天/权限确认/diff/终端的人工回归（无头环境不可行，留待真机安装时人工过一遍） |
| 3 | 版本号与 package.json 一致、关于页可核对 | ✅ | package.json `0.1.0` == 文件名 FlexAgent-0.1.0-setup.exe；TitleBar About 对话框 `data-testid="about-version"` 渲染 `__APP_VERSION__`（electron.vite.config.ts:39 define，源头 package.json——单一来源） |
| 4 | 升级路径：覆盖安装数据保留 | ✅（文档化） | 安装器不触碰 `%APPDATA%/FlexAgent/`（userData）与 `~/.flexagent/`（配置）；NSIS deleteAppDataOnUninstall:false；docs/packaging.md「升级」节 |
| 5 | 卸载路径明确（数据保留说明） | ✅（文档化） | docs/packaging.md「卸载」节：数据保留 + 手动清理三处路径 |
| 6 | 未签名提示/绕过说明 | ✅（文档化） | docs/packaging.md「未签名安装」节：SmartScreen 更多信息→仍要运行 / Unblock-File / 后续签名路径 |

## 门禁

- `npm run test`：75/75（lane 改动仅 devDep/scripts/build 配置 + docs，不影响运行时代码）
- lint/typecheck：两处已知外来失败（pluginMcpOverrides.ts:16、useChat.ts:46）不变——非本车道

## 诚实缺口

- **Box 2 未勾**：全新机器人工回归未执行（打包启动冒烟替代部分验证）；真机安装后需人工过一遍核心链路。
- 代码签名未配置（spec 允许后置，docs 已写后续路径）。
- blockmap 供增量更新用；自动更新通道（electron-updater）不在本票范围。
- 构建 artifacts（dist/）不入库。
