# 20: 凭据加密（安全路线图 P1）

**What to build:** 自定义模型与 MCP 配置中的秘密字段（API key 等）不再以明文落盘：写入时经操作系统凭据设施（Electron safeStorage，Windows 走 DPAPI）加密存储，读取时解密使用。兼容既有明文文件：首次读取检测到旧格式时解密迁移并覆盖，迁移失败保底不破坏可用性（明确报错而非静默丢配置）。内存中的明文只在必要窗口存在，不写入日志/诊断输出（与既有密钥脱敏层协同，确保凭据不进 JSONL）。

**Blocked by:** 01 (落库未提交子系统)

**Status:** done (2026-09-26 15:50) — 20a `5b0e342` + 20b（=26）`5efef6b`，两条路径都已落库。
（本条曾于 15:10 由 "done（部分）" 改回 blocked，理由是"部分完成"会掩盖模型 API key 仍明文；
26 落地后解除。保留这段是为了说明：**"done（部分）"在这个仓库里不被接受为终态**。）

拆票：**20a（MCP 配置）已 done 并落库**（`5b0e342`）；**20b（models.json / 模型 API key）阻塞未做**，
见新票 **26**。理由是"done（部分）"这个写法会把安全 P1 的真实状态藏起来：加密覆盖了用户 MCP 配置，
但绝大多数用户真正持有的秘密是模型 API key，那一份今天**仍是明文**。按用户视角这张票交付的是 0。
INDEX 里 20 的状态以本条为准 = blocked，直到 26 落地。

## 现状核对（2026-09-26）

**完全缺失**：全仓没有使用操作系统凭据设施（无加密/解密调用），模型配置与用户 MCP 配置里的
密钥字段按明文写入磁盘文件。

已有的、可以复用的部分：

- 输出侧脱敏层（工具结果与助手消息进入上下文前替换）已经存在，本单的"密钥不进日志"可以顺着它接。
- 写入路径是外科手术式的（只改命中条目、保留未知字段），加一层加解密不改变这个形状。

**风险**：

- 密钥所在的 worker 是 worker_thread，凭据设施只在主进程可用 —— 需要走主进程代理，
  这是一次进程间接口的改动，涉及契约层。
- 迁移要覆盖"文件已是明文"与"文件已是密文"两种输入，且迁移失败必须保底可用。
- 该接口改动会同时触及模型配置与 MCP 配置两条存储路径。

- [x] 新写入的秘密字段为加密形态，磁盘上无明文 key（`mcp.json`）
- [x] 旧明文配置读取兼容并自动迁移，迁移过程有日志
- [x] 解密失败时给出可操作错误，不静默清空配置
- [x] 密钥不进任何 JSONL/诊断日志（用脱敏层回归验证）
- [x] 加密读写有单测（mock safeStorage 覆盖存/取/迁移/失败四路径）
- [~] models/mcp 相关 QA 脚本更新并全绿 —— mcp 侧 24/24；`models.json` 一侧随阻塞一起延后

## 已完成范围（2026-09-26）：用户级 MCP 配置

落盘文件 `~/.flexagent/mcp.json`（`src/main/userMcp.ts`）。**该文件的读取方只有本仓库的
`loadServers()`**，密钥经 `mergeUserMcpIntoSpec` → `PluginResourceSpec` 走既有内存路径进 worker，
所以加解密可以完全放在"写那一刻加密 / 读那一刻解密"，**零 IPC 变更、零契约变更、worker.ts 未动**。

### 落盘形态

```
"headers": { "Authorization": "ss1|<base64>" }      // Electron safeStorage（Windows DPAPI 等）
"env":     { "API_TOKEN":     "hv1|<base64>" }      // AES-256-GCM，密钥在 ~/.flexagent/vault.key
```

- **为什么是字符串信封而不是对象**：`env` / `headers` 在契约里就是 `{ [name: string]: string }`，
  换成对象是一次契约变更 + IPC 载荷变更，而字符串让上层根本感知不到保险箱存在。
- **为什么要有两个 codec**：`ss1` 是正主（OS 保管密钥）；`hv1` 只用于拿不到 safeStorage 的运行体
  （本仓 QA 脚本、`node` 诊断脚本）。它弱于 OS 保管，但同样不写明文，而"拒绝存密钥"比存成弱加密更糟。
- 整个 `env` / `headers` 表整体加密（含看起来无害的 `PATH`）：字段名已经说明"这里放凭据"。

### 四条路径

| 路径 | 处理 |
|---|---|
| **存** | `persist()` 是唯一出口，写前 `sealConfig()` 逐值加密 → 磁盘不含明文；写后 `chmod 0600` |
| **取** | `decryptSecret()` 解信封；明文只在内存窗口存在，`list()` 读后文件字节不变 |
| **迁移** | 读到非信封值 = 旧明文文件：照常用（这是唯一副本），随后立即重新加密回写，`console.info` 打条数 + 算法名（不含值） |
| **失败** | 非严格读（`list()` / 进 worker 的 merge）：保留条目、值换成 `__vault_unreadable__`、console.error 点名条目；严格读（`save/remove/toggle`）：抛 `ContractError`，正文可执行（"删掉这条重填 token"），文件不动 |

迁移重写失败也不抛错：内存里的值照样可用，磁盘保持原样，只打 error —— 比启动不了更可取。

### 顺带修掉的脱敏层缺口

`secretPatterns.ts` 原有两条规则漏判，均已收紧（8 字符下限 / JSON 的 `"key": "value"` 引号在冒号前）：

- 12 字符以下、又没有厂商前缀的密钥（`sk-abc123`）会被当成正文放过；
- `{"Authorization": "sk-abc123"}` —— 引号在冒号**前**，原正则只处理 `apiKey = "x"` 那种引号在冒号后的写法，
  于是"模型 `cat` 一个配置 JSON"这条最常见的泄漏路径其实是漏的。

## Blocked by (new)：`models.json` 无法就地加密

**结论**：PI 的 `ModelRuntime` 在 **worker_thread** 里直接读这个文件，本单没有可用的接缝，
工单正文已经预判到的"需要走主进程代理"这一步会撞上硬约束（不许新增 IPC 消息类型、
不许改 `worker.ts`），因此**不在本单范围内**。

证据（内核包 `node_modules/@earendil-works/pi-coding-agent/dist/`）：

- `core/model-runtime.js:74` —— `options.modelsPath ?? join(getAgentDir(), "models.json")`，
  `ModelRuntime.create()` 里 `await ModelConfig.load(modelsPath)`；`ModelRuntime.create()` 由
  `src/main/worker.ts:806` 调用，凭据设施在主进程，worker 拿不到。
- `core/model-config.js:262` —— `validateModelsConfig.Check(parsed)` 是**整文件**严格 schema 校验：
  `apiKey` 换成对象会让"Invalid models.json schema"直接清空全部自定义模型（即 `userModels.ts` 头注写的那个坑）。
  换成 `ss1|…` 字符串能过 schema，但 `core/provider-composer.js:331` 会把密文当Authorization 发出去 → 每个请求 401。
- `~/.flexagent/mcp.json` 是**独有**文件，`models.json` 是**共享**文件，两者的可交付性不在一个量级。

**建议的后续方案**（需另开工单，且必须动 `worker.ts` 或契约）：

1. 主进程持有保险箱；新增一条 IPC 让 worker 按 `provider` 取明文密钥（**本单刻意没做**，避免与并行工单撞契约）；
2. 或者用内核自带的 `ENV_AGENT_DIR`（`PI_CODING_AGENT_DIR`）把 worker 的 agent dir 指到一份
   由主进程解密后写入的影子目录 —— 不动 IPC，但会连带挪走 `settings.json` / `auth.json` / `sessions`，
   影响面比本单大得多，且要动 `kernel.ts`（本单文件边界之外）。

## 验证

```
node scripts/qa-credential-vault.mjs     # 24/24 PASS
npm run build                            # ✓ built in 8.29s
npm run typecheck                        # 本单 0 报错（红全部来自并行工单的 ipc.ts/worker.ts/preload）
```

**负向验证**（`git show HEAD:` 还原旧 `userMcp.ts` + 旧 `secretPatterns.ts` 后重跑）：
旧实现 **12/24**，FAIL 的正是承重断言 —— "save 后磁盘无明文"、"存的是信封"、"迁移有日志"、
"迁移回写"、"解密失败给出可执行错误"、"密钥进日志能被抓到"（旧实现下 9 字符明文 token 确实落进了
`permissions.jsonl`）。恢复新实现后回到 24/24。

## 残留风险

- `hv1` 不是 OS 保管：拿到 `~/.flexagent/vault.key` 的攻击者可解密 `hv1` 信封。真机 Electron 内走 `ss1`，风险不成立。
- `chmod 0600` 在 Windows 上是空操作，`mcp.json` 的 ACL 仍取决于 umask。
- `list()` 仍把解密后的 `env` / `headers` 原样返回给 renderer（`UserMcpServerSummary.config`）——
  这是既有契约，本单不动；设置面板里能看到明文密钥。收敛需要改契约，建议单开。
- 迁移是"读时触发"，`mergeUserMcpIntoSpec` 里是 fire-and-forget 回写：并发的两次 merge 可能各写一遍（内容相同，原子写兜底）。
- `models.json` 侧仍在明文落盘（见阻塞）。
