# 设置内自定义模型（Settings › Models）

**实现时间：** 2026-09-24
**需求：** 「设置中加模型配置项」—— 不重启、不手改 JSON 就能增删改自定义模型，保存后立刻能在 Composer 里选。

---

## 1. 结论先行

| 关注点 | 结论 |
| --- | --- |
| 写入哪个文件 | **内核自己的** `getAgentDir()/models.json`（默认 `~/.pi/agent/models.json`） |
| 路径怎么来的 | **问 worker**（`modelsPath` 请求 → `join(getAgentDir(), 'models.json')`），main 侧**绝不自己推导** |
| 何时生效 | 保存后立即。worker 里 `runtime.refresh({ providers, allowNetwork: false })` **原地重读重组** |
| 为什么不用重启 | 所有已 attach 的会话**共享同一个 `ModelRuntime` 实例**，原地 refresh 对它们同时生效 |
| 「写盘成功」与「内核生效」 | **分开汇报**。写后向内核核对 `getModel(provider, id)`，对不上就回一个 `error`，UI 显示为告警而不是假装成功 |
| 契约版本 | v1.9：4 个方法 + 4 个 IPC channel + `CUSTOM_MODEL_NOT_FOUND` |

---

## 2. 为什么路径必须是内核给的

第一版把 `models.json` 推导成 `~/.flexagent/models.json`（沿用 `~/.flexagent/skills`、`~/.flexagent/mcp.json` 的直觉）。结果是**静默失败**：文件写进去了，内核一个模型都没多。

PI 的实际定义（`dist/config.js`）：

```js
export const CONFIG_DIR_NAME = pkg.piConfig?.configDir || '.pi'
export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR` // → PI_CODING_AGENT_DIR
export function getAgentDir() {
  const envDir = process.env[ENV_AGENT_DIR]
  if (envDir) return expandTildePath(envDir)
  return join(homedir(), CONFIG_DIR_NAME, 'agent')   // → ~/.pi/agent
}
```

即 agent dir **可由环境变量改写**，且默认落在 PI 自己的目录下，不是 FlexAgent 拥有的任何路径。

因此本模块的第一条设计原则写进了代码注释与 worker 协议里：

> 路径由内核权威给出，main 侧不推导。

数据流：

```
renderer  →  IPC.listCustomModels / saveCustomModel / removeCustomModel
main/ipc  →  await kernel.modelsPath()            // 每次现问，不缓存
             customModels.save(path, input)       // 写盘
             kernel.reloadModels(providers, verify)
kernel.ts →  worker 请求 { type: 'modelsPath' } / { type: 'reloadModels', ... }
worker.ts →  join(getAgentDir(), 'models.json')
             runtime.refresh({ providers, allowNetwork: false })
```

`modelsPath` 也直接暴露给 UI（`IPC.customModelsPath`），设置面板上那句 "Custom models are written to …" 显示的是**内核此刻的实际路径**，不是硬编码文案。

---

## 3. `reloadModels` 为什么要带 `verify`

写盘这件事**必然成功**（或必然抛错），所以它不能作为成功判据 —— 错误路径那次就是这么骗过 UI 的：磁盘上有条目，内核里没有。

所以 worker 在 refresh 之后**回头核对一次**：

```ts
const resolved = runtime.getModel(provider, id) !== undefined
if (resolved !== present) {
  return { error: runtime.getError() ?? (present
    ? `The kernel did not register ${provider}/${id}.`
    : `The kernel still resolves ${provider}/${id} after removal.`) }
}
```

`present` 由调用方给：新增/修改传 `true`，删除传 `false` —— 同一条通道同时覆盖了"该出现的没出现"和"该消失的没消失"两种失败。

结果分两层回到 UI：

| 字段 | 含义 |
| --- | --- |
| `CustomModelWriteResult.models` | 写盘后的完整列表（不含任何密钥） |
| `CustomModelWriteResult.error` | 文件写了、内核没认。UI 显示为 `kernelWarning`，**不假装成功** |

---

## 4. 外科式写入（`src/main/userModels.ts`）

`ModelConfig.load` 会**校验整个文件** —— 一个坏 provider 会让**所有**自定义模型一起失效。用户文件里除了我们的条目，还可能有 `modelOverrides`、`compat`、cost 表、未知顶层键。因此写入必须是外科式的：

| 行为 | 做法 | 理由 |
| --- | --- | --- |
| 保留未知字段 | 只在 `providers[id].models[]` 上增删改，其余原样带过 | 用户的文件不是我们的 |
| 保留缩进 | `detectIndent(raw)` 探测原文件缩进再序列化 | 避免整文件 reformat 造成巨大 diff |
| 保留模型顺序 | provider key 排序，但 `models[]` **按原文件顺序** | models 数组就是模型选择器的展示顺序 |
| JSONC 容错 | 自写 `stripJsonComments` | 用户可能留了注释 |
| 原子写 | `writeFileAtomically` | 与 `UserMcpService` 同一套先例 |
| 写入前自检 | `assertComposable()` 复刻 PI 的拒绝条件（缺 `baseUrl`/`api`/`apiKey` 即抛 `INVALID_INPUT`，给人话原因） | 别把坏数据写进一个"整文件校验"的文件 |

### 密钥语义

- `apiKey === undefined` ⇒ **保留已存值**。编辑已有 provider 下的某个条目时留空 key，绝不能把整个 provider 的凭据清掉。
- `apiKeySet: boolean` 是唯一对外暴露的凭据信息，`apiKey` 从不离开主进程。
- 删掉某 provider 的**最后一个** model 时：若该 provider 还有 `PROVIDER_KEEP_KEYS`（`modelOverrides` / `headers` / `compat` / `oauth` / `name`）之一，保留为 `models: []`；否则整条删除。**刻意不含 `baseUrl` / `apiKey` / `api`** —— 删一个模型不该在磁盘上留下密钥。

---

## 5. 走查证据

`scripts/qa-model-settings.mjs`（自写 CDP 客户端驱动真实 Electron），**20/20 PASS**，其中带证据的关键断言：

| 断言 | 实测 |
| --- | --- |
| 路径解析 | `C:\Users\HP\.pi\agent\models.json`（既有 provider：`USTC`） |
| 既有条目列出 | 10 行，provider `[USTC]` |
| 空提交被拒且未写盘 | 通过 |
| `kernel listModels` 含新模型 | `{"provider":"qa-provider","id":"qa-model-1","label":"QA Model One"}` |
| **已 attach 会话可切到新模型（无需重启）** | 通过 —— 证明 `runtime.refresh` 原地生效 |
| Composer 选择器列出它 | 是 |
| `apiKeySet` 为 true 且不返回 key | 通过 |
| 删除后从内核消失 | 通过 |
| 既有 providers 未被触碰 | before=`[USTC]` after=`[USTC]` |
| **用户 `models.json` 逐字节还原（行尾归一化）** | 通过 —— 证明外科式写入没有污染用户文件 |

---

## 6. 已知边界

- 设置面板只提供 3 种 api 方言（`openai-completions` / `openai-responses` / `anthropic-messages`），但 `CustomModelEntry.api` **回显文件里的原值**，不把 PI 支持的其它方言（`google-generative-ai`、`azure-openai-responses`、…）截断。
- 走查脚本在 `.gitignore` 的 `*.png` 规则下会把 `.qa-shots/` 一并忽略（预期行为）。
