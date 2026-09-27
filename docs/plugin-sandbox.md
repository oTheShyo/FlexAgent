# 插件 / hooks 沙箱（工单 22）

插件扩展与 hook 脚本在子进程里跑。这份文档说明**子进程能看到什么、从哪里启动、什么情况下根本不启动**，以及存量插件怎么迁移。

## 现状，一句话

以前是 `shell: true` + 完整 `process.env`：那不是沙箱，那是把本机所有凭据递给一个刚下载的压缩包。现在默认按来源给一个能力集，声明之外的东西要人来点头。

## 能力集

```ts
interface PluginCapabilities {
  fs: 'none' | 'plugin-data' | 'workspace'
  env: 'minimal' | 'inherit'
  network: boolean
}
```

| 来源 | 默认（没人点头也能跑） |
| -- | -- |
| `marketplace` | `LEAST_PRIVILEGE` = 只自己的数据目录 + 最小环境 + 无网络 |
| `local` / `bundled` | 工作区 + 最小环境 + 无网络 |

`env: 'minimal'` 是**白名单**，不是"复制一份再删掉已知的坏键"：只给 `PATH` 家族和 `TEMP`/`TMP`/`SystemRoot` 这类让命令能跑起来的键。插件需要的关于项目的信息走文档化的 `FLEX_*` 覆盖层（`hookRunner` 的 overlay），不靠继承。

## 强制执行的部分

| 边界 | 在哪儿拦 | 拦得住吗 |
| -- | -- | -- |
| 子进程的环境变量 | `buildSandboxEnv` | 拦得住，白名单生成 |
| 子进程的启动目录 | `resolveSandboxCwd` | 拦得住 |
| 声明超出授权 → 不启动 | `runHook` 返回 `sandbox_denied` | 拦得住（进程还没生出来） |
| `type: 'process'` 的可执行文件在沙箱外 | `boundaryViolation` → `sandbox_boundary` | 拦得住（同上） |
| 进程启动**之后**它去读什么 | — | **拦不住**，见下 |

Windows 上 Node 没有 job object / AppContainer 可以放进子进程，所以「hook 只能碰工作区」在本进程控制的边界上是强制的，越过边界之后是**声明**的，不是强制的。这是写下来的缺口，不是被掩盖的缺口。

## 授权

- 插件在 `plugin.json` 里写 `capabilities`（可只写部分字段）；`hooks/hooks.json` 也可以在 `hooks` 旁边写一份。
- 声明超出来源基线 → 插件详情面板显示能力清单 + `Grant` 按钮；不点就按基线跑。
- 授权写在 `~/.flexagent/plugin-grants.json`（原子写），卸载插件时自动撤销。
- 授权是"全部或基线"：半授权需要一个挑选 UI，现在没有，所以不做。

IPC：`codex:setPluginCapabilities`，`capabilities: null` = 撤销。`getPlugin` 返回 `PluginCapabilityView`（`effective` / `requested` / `needsGrant` / `granted` / `lines`）。

## 存量插件迁移

1. **什么都不做也能跑**：没有 `capabilities` 声明的插件按来源基线跑。真正的破坏点只有一个——**基线不再继承父进程环境**。
2. hook 里如果用了 `PATH` 之外的环境变量（`HOME`、`APPDATA`、代理、`*_API_KEY`），在 `plugin.json` 里声明 `capabilities.env: 'inherit'`，然后由用户在详情面板授权。
3. 项目自带的 hooks 文件（不是插件）按 `local` 基线 + 文件自己的声明计算，**不需要授权**——文件在本仓库里，写它的人就是同意的人。
4. `examples/hooks/hooks.json` 用 `type: "command"` + `node`：`PATH` 在白名单里，cwd 是工作区，迁移后照常工作（已在沙箱下验证）。

## 诊断

hook 被沙箱拦下时进诊断，代码两种：

- `sandbox_denied` —— 声明超出授权。
- `sandbox_boundary` —— 可执行文件落在沙箱根之外。

诊断串格式：`{event} hook [{code}]: {message}`，与既有 hook 诊断同一出口。

## 代码位置

| 文件 | 职责 |
| -- | -- |
| `src/main/sandbox.ts` | 策略：默认值、环境白名单、cwd、roots、授权读写（纯逻辑，可单测） |
| `src/main/hooks/hookRunner.ts` | 执行：拒绝、边界检查、spawn |
| `src/main/pluginBridge.ts` | 把每个 hook 的能力集算出来并传下去 |
| `src/main/pluginRegistry.ts` / `hookSources.ts` | 声明的读取 |
| `tests/sandbox.test.ts` | 策略与边界的回归 |
