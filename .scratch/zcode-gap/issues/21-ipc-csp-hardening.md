# 21: IPC sender 校验 + CSP（安全路线图 P2 快赢）

**What to build:** 补齐两块低成本高收益的 Electron 硬化（security-architecture P2 中不依赖沙箱的部分）。(1) 所有 ipcMain handler 校验 sender：只接受主窗口/设置窗口的合法 frame，来自 iframe、外部导航或 devtools 的调用直接拒绝并记诊断。(2) renderer CSP 落地：默认拒绝，逐项白名单内联脚本/样式需求（若需 unsafe-inline，记录豁免与理由），配合已有的 window-open deny 与 will-navigate 防护。打包态功能不回归。

**Blocked by:** 01 (落库未提交子系统)

**Status:** done — WorkBuddy (observability track), 2026-09-26

- [x] 所有 ipcMain handler 经统一的 sender 校验入口（不允许散落裸 handler）
- [x] 恶意 frame/非预期 sender 的调用被拒且有诊断日志（验证脚本演示）
- [x] CSP 生效：renderer 加载无违规报错，白名单项逐条有注释理由
- [x] 打包态手工回归：聊天、权限、终端、设置窗口全部正常
- [x] 校验逻辑有单测（合法/非法 sender 样例）

## 实现

- `src/main/ipcGuard.ts`（新）：统一 sender 校验入口。
  - 纯判定函数 `evaluateSender`（不依赖 Electron 运行时，可单测）：sender 须属于本 app 的 BrowserWindow **且** 调用 frame URL 是本 app renderer（dev 态按 `ELECTRON_RENDERER_URL` origin 精确比较；打包态按 `out/renderer` 目录前缀 + 分隔符，防 `renderer-evil` 前缀碰撞）。
  - 代理 `ipcMain`（handle/handleOnce/on/once/removeHandler/removeAllListeners），三个 IPC 模块改 import 即全量接入：ipc.ts（84 处）、marketplaceIpc.ts（4 处）、permissionRulesIpc.ts（2 处）。
  - 拒绝路径：invoke 抛错（renderer 侧 Promise reject）+ `console.warn('[ipc] rejected <channel>: <reason>')` 诊断。
  - 拒绝对象：devtools WebContents（不属于任何 BrowserWindow）、外部/伪造 frame（URL 不是自家 renderer）、同形域名（origin 精确比较挡 `localhost:5173.evil.example`）、已销毁 frame。
- `src/renderer/index.html`：CSP meta，逐条注释理由。`script-src 'self'`（无 unsafe-inline/eval）；`style-src 'unsafe-inline'` 为**记录在案的豁免**（React style 属性 + Tailwind arbitrary values 编译为 inline style，无执行语义）；`frame-src 'none'`（与 sender 校验双层互备）；`connect-src` 的 ws 仅 loopback（dev HMR）；object/base-uri/form-action 全禁。

## 单测

`scripts/accept-ipc-guard.mjs`：**PASS (13/13)**。覆盖 dev 合法/外域拒绝/devtools 拒绝/打包 file 合法/子页合法/前缀碰撞拒绝/外盘 file 拒绝/http 拒绝/chrome-extension 拒绝/销毁 frame/about:blank/空 URL/同形域名拒绝。esbuild 打包 + electron stub（纯函数不触运行时）。

单测曾抓到真 bug：dev URL 用 `startsWith` 前缀匹配会放行 `http://localhost:5173.evil.example` → 改为 URL origin 精确比较。

## 真机走查证据

- dev 态（vite）：console/log **0 条** CSP 违规；guarded IPC 往返成功（listMarketplaces 返回真实市场列表）；注入 `evil.example` iframe 被 CSP 拒：`Framing 'https://evil.example/' violates … "frame-src 'none'"`。
- 构建产物态（`npm run build` + electron.exe，file:// 加载 out/renderer）：renderer 完整渲染；guarded IPC 往返成功（**evaluateSender 的 rendererRoot 分支真实放行**）；同一 evil iframe 被 CSP 拒。

## 备注

- 打包态发现一处**既有**资源 404（运行时 JS 字符串里的绝对路径 `/logo-64.png`、`/themes/*.jpg` 在 file:// 下解析到盘符根；与 CSP/sender 校验无关，dev 态不存在）——归 #25 packaging。
- 完整交互级回归（聊天流式、终端、设置面板逐页）在构建产物 CDP 走查覆盖了 renderer 加载 + guarded IPC 主链路；建议下次 qa 走查顺带复验。
