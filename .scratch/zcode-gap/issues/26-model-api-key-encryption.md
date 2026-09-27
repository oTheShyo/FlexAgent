# 26: 模型 API key 加密（凭据加密 20b）

**What to build:** 把 `models.json` 里的 `apiKey` 从明文改成加密形态，达到与 MCP 配置
（20a，`5b0e342`）同等的保护：写入即加密，读取即解密，旧明文文件照常使用并在下次写回时迁移，
解密失败报出字段名而不是清空配置。**这是用户真正持有的那一份秘密** —— 20a 覆盖了 MCP 配置，
但一个只配了自定义模型的用户今天拿不到任何保护。

**Blocked by:** 20a（已 done，2026-09-26）

**Status:** done (落库 `5efef6b`, 2026-09-26 15:50；2026-09-27 验收区按实际设计改写并逐箱核验，见下)

## 实际做法与工单原文的差别（重要，别照旧文字找）

工单原文写的是"加密**替换** models.json 里的 apiKey"。**实现不是这样**，因为替换没有可行形态
（见下节验证）。落地的是**引用 + 分离**：

| | 内容 |
| -- | -- |
| `models.json` 的 `provider.apiKey` | `${FLEXAGENT_KEY_<PROVIDER>}` —— 一个引用，不是秘密、也不是密文 |
| `~/.flexagent/model-keys.json` | 真 key，经 `credentialVault` 密封（`ss1`/`hv1`） |
| 运行时 | main 解密 → 进程通道 → worker 调 `modelRuntime.setRuntimeApiKey()` 注入 |

为什么引用是安全的：一旦存在运行时凭据，配置里的值**根本不会被解析**（实测
`scripts/probe-runtime-apikey-header.mjs`：models.json 里放一个无法解析的模板，注入后照样
发出真 key；不注入则请求根本发不出去）。引用刻意做成"缺 key 时会响亮失败"，而不是退化成
一个假 token 静默 401。

为什么走进程通道而不是环境变量：env 会被 agent 起的每个 bash 子进程继承，比被保护的这个文件
暴露面更大。

## 两条实测结论（推翻/修正了原判断）

1. 原判断"换对象→schema 失败、换密文→当 header 发出"**成立**。
   `model-config.js:258` 对整文件做 `validateModelsConfig.Check`，失败则 providers Map 全空；
   `ProviderConfigSchema.apiKey = Type.Optional(Type.String({minLength:1}))` 只接受字符串。
2. 但**不用就地加密也能解决** —— `ModelRuntime.setRuntimeApiKey()` 是公开方法，
   且 `provider-composer.js:251` 的 `resolve()` 里 `input.credential` 优先于配置值。
   这条接缝是原工单没有预判到的，也是本单能收敛的原因。

## 为什么不能就地加密（已验证，别再重新试一遍）

PI 的 `ModelRuntime` 在 **worker_thread 里直接 `ModelConfig.load` 整个文件**，两条路都堵死：

| 做法 | 后果 |
| -- | -- |
| `apiKey` 换成对象（信封形态） | 整文件 schema 严格校验失败 → **用户的全部自定义模型被清空** |
| `apiKey` 换成密文字符串 | PI 把该字符串当 Authorization 头发出去 → 请求 401，且密文进了网络日志 |

所以只能**不让 worker 直接读这个文件**：加一层主进程代理，worker 需要 model config 时走 IPC
拿到已解密的明文，磁盘上始终是密文。

## 必须守住的三条（改 models.json 的老规矩）

1. **外科手术式写**：只改命中的条目，保留未知字段与缩进，不移动已有密钥。
2. **`apiKey === undefined` 表示保留已存密钥**，不得写成空串或密文空串。
3. **写后回读核对**，把结果回报 UI —— 写错让用户看到，不要静默。

## 验收（2026-09-27 改写并逐箱核验——原文按"信封写进 models.json"的旧设想写，与上表实际设计矛盾，故按实际口径判定并在每条注明出处）

- [x] 新写入的模型 key 在磁盘上不含明文 — 实际形态：`models.json` 只存 `${FLEXAGENT_KEY_<PROVIDER>}` 引用，真 key 封存在 `~/.flexagent/model-keys.json` 的 `ss1|` 信封里。`.scratch/probe-keyshape.mjs` **5/5**：models.json 全 provider 分类为 引用/用户模板（0 个原文 key 嫌疑），model-keys.json 逐值 isEnvelope，信封头 `ss1`（不打印任何 key 值）。
- [x] 旧明文文件首次读取照常可用，并迁移为密文；迁移有日志 — `kernel.applyModelKeys` 每次读前跑 `migratePlaintextKeys`（读路径迁移，不等用户编辑）；`scripts/qa-model-key-vault.mjs` 29/29 中 `the migration names the provider it moved` / `the migrated file has no plaintext` / `the migrated key is readable` / `a second pass moves nothing` 四连；用户自写的 `$VAR`/`!cmd` 模板不动（`adoptPlaintextKey` 明示）。
- [x] 迁移/写入失败保底：明确报错，不清空配置、不丢模型 — 存储损坏时 `readStore` 抛 `KERNEL_INTERNAL: Model key store is unreadable … not overwriting it`（坏文件不被覆盖）；qa-model-key-vault `the broken entry is reported` / `it is not handed over as a key` / `the provider is named for cleanup`；`qa-model-settings` 20/20 证明存取往返后 `models.json` 逐字节还原、既有 provider 不变。
- [x] 解密失败报出字段名（哪个 provider），不静默降级为空 — `decryptSecret(value, \`model key for "<provider>"\`)`；失败进 `ModelKeysRead.unreadable` 按名上报（probe-keyshape：应用外解不开 `ss1` 信封 → `unreadable=[USTC]`、0 个假可读）；qa 断言 `its error log names the provider, not the key` 且 `does not interpolate the key`。
- [x] 明文不进 JSONL / 诊断日志 — 负向用例在 `scripts/diag-security.mjs` **32/32**：`sk-proj-` 类 key 经 `redactSecrets` 后消失、audit 自身字段 `sk-zzz` 不出现在 JSONL（`audit masks secrets inside its own fields`）；模型 key 走进程通道不走环境（`qa-model-key-vault: it injects through the runtime, not the environment`），env 不被 bash 子进程继承。
- [x] 模型列表、切换、推理强度选择在加密后全部正常（`reasoning`/`compat` 等字段未被破坏） — `qa-model-routing.mjs` **34/34**、`qa-model-settings.mjs` **20/20**（列表/表单/会话内切换无需重启/composer picker 列出新模型/删除还原基线）；当日真机 probe：`listCustomModels` 10/10 `apiKeySet=true` 且无原始 key，image 走查内 `setModel` 切换后完成一次带鉴权的多模态回合（会话 945ba190）。
- [x] 覆盖存 / 取 / 迁移 / 失败四条路径，并做负向验证（退回旧实现断言必须 FAIL） — 形式修正：这四条由集成级脚本 `scripts/qa-model-key-vault.mjs`（29/29，真实 fs + vault）覆盖，非 vitest 单测（Electron safeStorage 不在 vitest 射程内）。负向验证已做并写进落库信息（`5efef6b`）：*reverting the save path to writing the key straight through fails five of them, including the one that greps the file for the plaintext*。

> 2026-09-27 附带修复（同批验收中发现的既有脚本破损，非本票引入）：`qa-credential-vault.mjs` 收尾 `rmSync(undefined)` 崩溃（解构字符串）→ 24/24 exit 0；`qa-context-refs.mjs` 被 11 号票引入的值导入 `../types` 目录解析打断 → 加 `module.registerHooks` 解析垫片，15/15 恢复；`qa-model-settings.mjs` 的 composer picker 选择器被 07 号票的 plan-mode 按钮截胡 → 改用 `composer-model-chip` testid，20/20。

## 风险

改动面是契约 + IPC + worker 三处，且触碰模型选择这条热路径。**做之前先确认 IPC 通道能否复用
现有的 `getModelConfig`**，能复用就不要新增消息类型（契约四方核对成本很高）。
做不了就在本票下记 `## Blocked by (new)`，不要为了闭环而闭环。
