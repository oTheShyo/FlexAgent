# 打包分发（Windows）

工单 25 交付：electron-builder 产出 Windows x64 NSIS 安装包。

## 构建

```pwsh
npm run dist
```

等价于 `electron-vite build && electron-builder --win --x64`，产物在 `dist/`：

- `FlexAgent-<version>-setup.exe`（unsigned NSIS 安装包，~218–224 MB）
- `*.blockmap`（增量升级差分用）与 `dist/win-unpacked/`（免安装目录版）

**网络要求**：electron-builder 需从 GitHub 下载 winCodeSign/nsis 资源；在 GitHub 不可达的环境需设镜像：

```pwsh
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
npm run dist
```

## 版本号策略

`package.json` 的 `version` 是唯一来源：安装包文件名（`${productName}-${version}-setup.exe`）与关于对话框（TitleBar → About FlexAgent → `data-testid="about-version"`，经 electron-vite define 注入 `__APP_VERSION__`）均由它派生。改版本只改 package.json 一处。

## 安装

NSIS、**按用户安装**（`perMachine: false`，无需管理员），可选安装目录、桌面/开始菜单快捷方式、完成后可自动启动。

## 升级

新版覆盖安装即可：会话数据与配置**不受安装器影响**——

- 会话注册表与 PI 会话文件：`%APPDATA%/FlexAgent/`（Electron userData）
- 应用配置：`~/.flexagent/`（settings.json、agents/、observability 日志）

安装器不写入这两处，覆盖安装后全部保留。

## 卸载

NSIS `deleteAppDataOnUninstall: false`——卸载**保留**上述两处数据。如需彻底清理，手动删除：

- `%APPDATA%/FlexAgent/`
- `~/.flexagent/`
- 安装目录（默认 `%LOCALAPPDATA%/Programs/flexagent/`）

## 未签名安装（SmartScreen）

当前产物未做代码签名（可后置）。首次运行时 Windows SmartScreen 会拦截：

1. 双击安装包 → SmartScreen 弹窗点 **更多信息** → **仍要运行**。
2. 或预先解除单文件标记：`Unblock-File .\FlexAgent-0.1.0-setup.exe`。
3. 企业环境可用组策略排除，或后续配置签名证书（electron-builder `win.certificateFile` / Azure Trusted Signing）。

签名未配置不影响功能，只影响首次运行的提示门槛。
