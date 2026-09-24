# 设置窗口（Settings）

**实现时间：** 2026-09-25
**需求：** 「设置做成这种侧栏设置」—— 从「命令面板的一个变身状态」改为独立窗口：左侧分组导航 + 右侧单页内容。
**第二轮反馈：** 「设置窗口打开不要这么大」—— 从全屏页收成有界模态窗口。

---

## 1. 结论先行

| 关注点 | 结论 |
| --- | --- |
| 形态 | **有界模态窗口**：`w-[min(960px,92vw)] × h-[min(660px,86vh)]`，居中 + 半透明遮罩 + 圆角阴影。**不是**全屏页 |
| 导航 | 5 个分区、2 个分组标题：`General / Appearance / Shortcuts` →（Models）`Custom models` →（About）`Storage` |
| 一次渲染几个分区 | **一个**（`switch` 卸载其余），DOM 即真相；走查以「切到模型页后 General 必须消失」为断言 |
| 模型状态放哪 | `useCustomModels` 在**设置窗口顶层**，切分区不重读 `models.json`（表单随之关闭，是刻意的） |
| 层级 | 面板 40 → 命令面板 60 → 设置 70 → **权限请求 80**（`PermissionDialog` 由 `z-50` 提到最高，见 §3） |
| 能从哪里进 | 侧栏 `Settings`、以及命令面板的 `Settings` 命令（两者都走 `App.handleOpenSettings`） |
| 怎么出 | `Esc`（在 `App.handleEscape` 里排在命令面板之前）、右上角 × |
| 走查 | `scripts/qa-settings-shell.mjs`，**24/24 PASS**；`scripts/qa-model-settings.mjs` 20/20 PASS 无回归 |

---

## 2. 为什么不继续借用命令面板

原实现把设置当作命令面板的一个 `showSettingsNotice` 分支：同一个浮层、`max-w-lg→xl`、内容纵向堆叠（Appearance → Models → Shortcuts → Environment），要一路滚到底。

三个具体的坏处：

1. **没法加分区**。每加一块设置就多滚一段，用户找不到东西。
2. **宽度被命令面板钉死**。主题卡片、模型表单在 640px 里挤成两列。
3. **语义不对**。`role="dialog"` 的面板内部再套一个「设置」，`Esc` 的归属、焦点落点都是模糊的。

因此设置改为自己的组件 `SettingsPage.tsx`，命令面板**退回成纯命令面板**（这次改动净删了它约 130 行：两个设置专用组件、四个回调、一段三元 JSX）。

---

## 3. 层级：顺手修掉的一个既有缺陷

引入 `z-[70]` 之前先看了一遍现有浮层：

| 浮层 | 改前 | 改后 |
| --- | --- | --- |
| `DiffPanel` / `PluginDetailPanel` | `z-40` | `z-40` |
| `PermissionDialog` | `z-50` | **`z-[80]`** |
| `CommandPalette` | `z-[60]` | `z-[60]` |
| `SettingsPage` | — | `z-[70]` |

改前的问题**已经存在**：会话在后台跑到一半弹出权限请求时，如果命令面板正好开着（`z-60`），请求会被盖住 —— 而 `PermissionDialog` 是阻断式交互，它必须赢。权限升到 `z-[80]` 后，它盖过设置与命令面板两者。

## 4. 分区怎么定的

参考的界面里有「语言 / 链接打开方式 / 字体大小 / 允许锁屏运行 / 开机自启」这类条目，但本应用没有对应能力。按既有约定（**不做没有后端支撑的装饰性控件**），一条都没照搬，只放有真实来源的东西：

| 分区 | 内容来源 |
| --- | --- |
| General | 运行时真值：`window.electron.codex` 是否存在（Bridge）、`navigator.platform`、会话数、当前工作区 |
| Appearance | `lib/themes.ts` 的 5 个主题 + `lib/theme.ts` 的读写 |
| Shortcuts | `lib/shortcuts.ts` 的 `SHORTCUTS`（**只读**，页面明说没有重绑定） |
| Custom models | 内核自己的 `models.json`（详见 `docs/settings-models.md`） |
| Storage | 落盘位置：内核的 `models.json` 路径、本机专属的偏好覆盖层 |

`Storage` 一页承担了「哪些东西是本机的」这件事的说明义务：主题偏好、会话重命名/归档是**本机覆盖层**；会话与对话记录属于内核 —— 清空本机存储不会动它们。

## 5. 走查（`scripts/qa-settings-shell.mjs`）

27 项，覆盖容易悄悄坏掉的地方：

- 打开后**落在 General**（先在脚本里把可能残留的上一轮面板关掉，否则测的是残留状态）
- **是有界窗口而不是整个视口**（实测 `960×660 inside 1386×837`），有遮罩、有圆角
- **只有当前分区在 DOM 里**；切到模型页后 General 的卡片必须消失
- 主题网格 5 张卡片；点选后 `data-theme` 与 `localStorage['codex.theme.v1']` 同步变化，`aria-checked` 跟随
- **导航激活态**：`aria-current="page"` 恰好一个、且落在当前分区；再用 `getComputedStyle` 断言它**确实被画成激活态**（判据用 `font-weight` 500↔400 —— 背景色参与 `transition-colors`，会被读到过渡中间值，实测读到过 `alpha=0.03`）
- 三条关闭路径：`Esc`、× 、**点击遮罩**；命令面板的 `Settings` 命令也能打开且自身关闭
- **结束时逐字节还原用户主题**（`try/finally`，中途失败也会还原）

> 截图教训：本环境（`--disable-gpu --in-process-gpu`）下 `Page.captureScreenshot` 首次调用几乎必然超时，且偶尔返回**合成器旧帧** —— 曾拍到「内容已是 Storage、左侧仍高亮 Appearance」。所以高亮不能靠看截图判断，要走 `aria-current` + 计算样式；截图统一放到所有功能检查之后，失败只告警。
