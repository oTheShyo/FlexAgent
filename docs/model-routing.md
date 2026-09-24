# 模型路由层（Settings › Routing / Proxy & timeouts）

**实现时间：** 2026-09-24
**需求：** 「参考《第十一章：模型路由》这篇方法论做模型路由改造」
**授权范围：** 主对话 + 上下文压缩 + 调用台账；§8 代理与 §9 流式超时「接上」。

---

## 1. 结论先行

| 关注点 | 结论 |
| --- | --- |
| 路由表存哪 | `~/.flexagent/routing.json`（本应用自有策略，PI 没有 per-purpose 模型的概念） |
| 网络设置存哪 | **内核自己的** `getAgentDir()/settings.json`（`httpProxy` / `httpIdleTimeoutMs` / `retry.maxRetries`）——路径由 worker 的 `settingsPath` 现问，不推导 |
| 角色有几个 | **2 个**：`chat`、`compaction`。只有真有消费者的用途才建角色 |
| `chat` 何时生效 | 只作用于**新建**会话（`createSession`）；`openSession` / `setSessionCwd` 不套用，让 PI 还原会话自己的模型 |
| 压缩怎么换模型 | `session_before_compact` 钩子 + 复用内核导出的 `compact()`。切点、分轮合并、文件操作脚注、用量记账仍是 PI 的 |
| §8 代理 | **SDK 路径下的真窟窿**：PI 只在 CLI `main()` 里调 `applyHttpProxySettings`/`configureHttpDispatcher`，本应用走 SDK，Node 默认 dispatcher 完全忽略代理环境变量 → 由 worker 自己装，装完如实回报 |
| §9/§10 超时与退避 | 内核在 SDK 路径下**本来就生效**（`buildRequestOptions` 每次请求现读设置）。本轨只做暴露 + 写入后让会话重读 |
| 「写盘成功」与「已生效」 | **分开汇报**。角色写后必再解析一次（解析不了就带 `error` 回前端）；网络写后必 `applyNetwork()`，并把 `dispatcher` / `envProxy` 回给 UI |
| 契约版本 | v2.0：5 个方法 + 5 个 channel |

---

## 2. 与文章的对照：已做 / 内核已做 / 刻意不做

| 文章 | 状态 | 说明 |
| --- | --- | --- |
| §2-C 用户自选 + 场景默认 | **已做** | 角色表 + 每角色一个选择器，未选即交回内核 |
| §2-D 自动降级 | **内核已做** | `retry` 与流式超时就是降级，见 §6 |
| §4 多服务商适配代价 | **内核已做** | PI 的 `Model.api` 方言分发已在 `models.json` 里处理；本轨不重复 |
| §5 模型白名单（声明能力） | **已做** | `ModelFacts` 读取内核目录的 `contextWindow` / `maxTokens` / `reasoning` / `input` / `cost`，面板按事实而不是按名字选。**不阻断**自定义模型（v1.9 已确立：保留入口，靠 `assertComposable` 挡坏数据） |
| §7 主对话 | **已做** | `chat` |
| §7 上下文压缩 | **已做** | `compaction` |
| §7 记忆提取 / 标题生成 / 子 Agent | **不做** | 本仓库没有这些调用点，造出来的角色配置不了任何东西 |
| §7 权限分类 | **不做** | 有调用点（`worker.ts` 的 `classifyBash` 今天硬编码 `getAvailableSnapshot()[0]`），但它落在另一条未提交的权限子系统里，跨轨改动 |
| §8 代理 | **已做** | 见 §5 |
| §9 流式超时 | **已做（暴露）** | 见 §6 |
| §10 退避+jitter | **已做（暴露）** | 内核实现；本轨不动参数 |
| §11 CoT 特殊处理 | **内核已做** | 推理内容由 PI 处理，本轨不碰 |
| §12 调用日志 / 台账 | **已做** | 见 §7 |

判断原则沿用既有约定：**没有后端能力支撑的开关一律 disabled + 说明**，不做能点但无效果的假控件。

---

## 3. 角色与 `routing.json`

```json
{ "roles": { "chat":       { "provider": "USTC", "id": "qwen-chat" },
             "compaction": { "provider": "USTC", "id": "qwen-chat" } } }
```

| 情况 | `source` | 面板怎么说 |
| --- | --- | --- |
| 没有绑定 | `kernel` | `chat` 显示内核 `settings.json` 的 `defaultProvider`/`defaultModel` 解析结果；`compaction` 无解析结果（它跟随会话当前模型） |
| 有绑定且内核能解析 | `binding` | `Bound to <name>` |
| 有绑定但解析不了 | `binding` + `error` | 红字说明（模型没了 / provider 没凭据）。**绑定保留**，不静默换默认 |

写入是外科式的（与 v1.9 的 `models.json` 同一套 `jsonFile.ts`）：只动被点的那个 role，未知顶层键原样带过，缩进保留。**清掉最后一个绑定时优先删除文件**，不留 `{"roles":{}}` 桩——空表和没有表是一回事，但只有一个看起来像状态。

**但删除会降级为写空表**：实测本机的删除守卫（`[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]`）会拦下 Electron 子进程对用户主目录下文件的 `rm`，而同一路径的**写入**畅通。删除失败时回退为写入 `{"roles":{}}`——两种形态读回来都是「未绑定」，所以清除绑定这个核心操作不能因为整洁偏好而失败。走查的还原判定把 `{}` 与「文件不存在」视为等价。

---

## 4. `chat` 只作用于新会话

`attachSession(sessionId, cwd, sessionManager, { applyChatRole })`：

- `createSession` 传 `{ applyChatRole: true }` → `resolveRoleModel(runtime, 'chat')` 有值就作为 `model` 传给 `createAgentSession`；
- `openSession` / `setSessionCwd` **不传** → PI 从既有 transcript 还原会话自己的模型。

理由：PI 的模型是**会话级**属性。用户在某个会话里手动切的模型必须赢过角色策略，否则「换个新会话试试」和「把我正在聊的这个换掉」会互相打架。

---

## 5. §8 代理：为什么必须自己装

```
PI dist/core/http-dispatcher.js
  applyHttpProxySettings(proxy)   → process.env.HTTP_PROXY ??= proxy / HTTPS_PROXY ??=
  configureHttpDispatcher(ms)     → new undici.EnvHttpProxyAgent({ bodyTimeout, headersTimeout, … })
                                    + undici.setGlobalDispatcher(agent)
  DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000
```

**只有 PI 的 CLI `main()` 调用它们。** 本应用走 SDK，所以：

1. `HTTP_PROXY` 不会被填；
2. 就算被填，Node 默认 dispatcher 也**不读**代理环境变量 —— `undici.setGlobalDispatcher` 那一步没人做。

于是 worker 自己做，三层细节：

| 细节 | 做法 |
| --- | --- |
| 怎么加载 | 子路径导入（`@earendil-works/pi-coding-agent/dist/...`）与 `require.resolve` 深路径**都**被 `package.json#exports` 拦（`ERR_PACKAGE_PATH_NOT_EXPORTED`，实测）。改走**文件 URL**：从 `__dirname` 向上找 `node_modules/@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js`。`electron.vite.config.ts` 的 `external` 已含 `/^@earendil-works\//`，动态 import 保持运行时解析 |
| 加载不到怎么办 | `dispatcher: 'unavailable'` + `note`，代理输入框 disabled。**不假装能设** |
| 环境变量谁说了算 | `applyHttpProxySettings` 只填空值 → 用户自己 export 的 `HTTP_PROXY` 会赢过设置项。worker 在启动时抓一份 `ambientProxy` 报给 UI 明说；清掉设置时**只删自己装过的那份**，不动用户的 |
| 重启后还算不算 | 算。`attachSession` 开头 `ensureNetworkApplied()`：从内核 settings 读回 `httpProxy`/`httpIdleTimeoutMs` 装一次（之后是已有的 promise，不是每次 attach 的开销）。**只在那一次运行里有效的代理不算设置** |

---

## 6. §9/§10 超时与重试：内核已实现，本轨只暴露

自我纠正记录：一开始以为 §9/§10 和 §8 一样在 SDK 路径下失效，读到 `sdk.js` 的 `buildRequestOptions` 后确认**它们本来就在生效** —— 每次请求现读 `settingsManager.getHttpIdleTimeoutMs()` 与 `getProviderRetrySettings()`。

所以本轨只做两件事：

1. 把 `httpIdleTimeoutMs`（含 PI 自己的 30s/1m/2m/5m/Disabled 档位）与 `retry.maxRetries` 暴露到设置面板；
2. **写入后让已 attach 的会话重读**：`reloadSessionSettings()` 逐个 `session.settingsManager.reload()`。

第 2 点是必需的：设置文件是主进程写的，而**运行中的会话只在每次请求时读**，不 reload 的话新值会在磁盘上闲置到下次 re-attach —— 与 v1.9「写了 `models.json` 内核没认」是同一个坑。

`retry` 是**合并**而非替换（保留 `enabled` / `baseDelayMs` / `maxAgentDelayMs` 与 per-provider 覆盖）；`maxRetries` 等于默认值 3 时删掉该键、`retry` 变空则删掉整个键。写入的字段**只动 patch 里有的**：改代理不会顺手给用户加一个他从来没有的 `httpIdleTimeoutMs`。

---

## 7. 台账：用途轴怎么来的

「调用来源」是文章 §12 强调的成本分析关键维度，也是唯一能回答「这轮为什么这么贵」的轴。数据**完全从会话自己的 entry 派生**，不另起一个可能漂移的计数器：

| session entry | 归到哪个用途 |
| --- | --- |
| `message`（`role: 'assistant'`） | `chat` |
| `message`（`role: 'toolResult'`） | `tool-results` |
| `compaction` / `branch_summary` | `compaction` |
| `usage` | 它自己的 `kind`（如 `cache_warm`） |

`UsageReport` 同时给按用途与按模型两块（`byPurpose` / `byModel`），按 cost 降序、并列时按规模。模型名取 `responseModel ?? model` —— 供应商实际回的那个，不是请求时写的那个。

---

## 8. 走查证据

`scripts/qa-model-routing.mjs`（自写 CDP 客户端驱动真实 Electron），**34/34 PASS**（最终一轮跑在**提交快照的 worktree**上，不依赖工作区里另一条轨的在制品）：

| 断言 | 实测 |
| --- | --- |
| 桥接 5 个方法齐全 | 通过 |
| 两个路径都由内核权威给出 | `~/.flexagent/routing.json` / `~/.pi/agent/settings.json` |
| `dispatcher` 状态 | `installed`（不是靠猜，是模块加载成功） |
| 内核目录被读出并渲染 | 10 个模型，面板 10 行 |
| 每个用途一行 | 2 行（`chat` / `compaction`） |
| 绑定被**内核**解析（不只是存下来） | `{"provider":"USTC","id":"qwen-chat"}` |
| 绑定写进 `routing.json` | 119 字节 |
| **新会话真的跑在绑定的模型上** | 内核自己的 `getModelConfig` 答 `{"provider":"USTC","id":"qwen-chat"}` |
| 清除后交还内核 | `source=kernel` |
| `compaction` 角色绑定可解析 | 通过（解析层；端到端见 §9） |
| **配置的代理真的进了请求路径** | 本地 TCP 监听器收到 **4 次连接**（脚本起的 `127.0.0.1:9876`）；清掉代理后同一次会话正常完成、代理 0 新连接 |
| worker 不把自己的代理当成用户环境变量 | `envProxy === null` |
| **台账把真实花销归到用途与模型** | `calls=5`、`byPurpose=[chat]`、`byModel=USTC/qwen-chat=5` |
| 超时/重试往返 | `idle=60000 retries=1` 且落到内核 settings.json |
| 面板控件写穿 | 空闲超时 `120000`；代理输入框失焦提交、清空即直连 |
| 用户 `settings.json` 逐字节还原（行尾归一化） | 通过 |
| 用户 `routing.json` 还原 | 通过（测试前不存在 → 清空后空表/不存在视为等价） |
| 走查期间 renderer 无 error 日志 | 通过（三类环境噪声显式列名，不宽泛吞错） |

---

## 9. 已知边界（未验证的部分，照实说）

- **压缩换模型没有端到端跑通。** 钩子实现依据是 PI 的公开契约（`session_before_compact` 返回 `{ compaction }` 即接管；`compact()` 从包入口导出，签名 `(preparation, model, apiKey, headers, customInstructions, signal, thinkingLevel, streamFn, env, retry, callbacks, sessionId)`，`streamFn === undefined` 时内部退回 `completeSimple`）。走查只验证了「绑定能被解析成内核模型」这一层。真正触发压缩需要接近写满的上下文窗口，而把 `compaction.reserveTokens` 调到接近 `contextWindow` 强行触发会让 `_compactBeforeNextAssistantResponse` 每回合都压缩一次（它没有 `_checkCompaction` 里那条「上次压缩晚于上次用量就不重复压缩」的守卫），代价和风险都不值得在一次走查里承担。**默认路径（不配 `compaction` 角色）返回 `undefined`，PI 行为与改造前完全一致**，这条是所有用户的默认状态。
- **`maxRetries` 的实际重试次数没有实测**（需要构造限流/断流）。只验证了写入、内核读回与 reload 链路。
- **清空最后一条绑定后可能留下 `{"roles":{}}`**：本机删除守卫拦子进程 `rm`（见 §3），回退写空表。功能无损，只是文件还在。
- **走查脚本自带崩溃兜底**：`restoreUserFiles` 同时挂在正常路径与异常路径上——早期版本一步抛异常就把用户的 `settings.json` 留在了改过的状态（实际发生过，已手工还原并修掉）。
- **代理是全局单开关**，不是「仅海外走代理」。内核的设置就是一个字段，面板里写明了这点，不做一个暗示更细粒度控制的 UI。
- **`envProxy` 是启动时的快照**，运行中改环境变量不会反映。
