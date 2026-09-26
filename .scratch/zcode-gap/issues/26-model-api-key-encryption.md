# 26: 模型 API key 加密（凭据加密 20b）

**What to build:** 把 `models.json` 里的 `apiKey` 从明文改成加密形态，达到与 MCP 配置
（20a，`5b0e342`）同等的保护：写入即加密，读取即解密，旧明文文件照常使用并在下次写回时迁移，
解密失败报出字段名而不是清空配置。**这是用户真正持有的那一份秘密** —— 20a 覆盖了 MCP 配置，
但一个只配了自定义模型的用户今天拿不到任何保护。

**Blocked by:** 20a（已 done，2026-09-26）

**Status:** done (落库 `5efef6b`, 2026-09-26 15:50)

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

## 验收

- [ ] 新写入的模型 `apiKey` 在磁盘上是信封形态（`<alg>|<base64>`），grep 不到明文
- [ ] 旧明文文件首次读取照常可用，并在下一次保存时迁移为密文；迁移有日志
- [ ] 迁移失败保底：明确报错，不清空配置、不丢模型
- [ ] 解密失败报出字段名（哪个模型、哪个字段），不静默降级为空
- [ ] 明文不进 JSONL / 诊断日志 —— 与既有脱敏层协同，写一条负向用例（把 key 塞进日志能被抓到）
- [ ] 模型列表、切换、推理强度选择在加密后全部正常（含 `reasoning` / `compat` 字段未被破坏）
- [ ] 单元覆盖存 / 取 / 迁移 / 失败四条路径，并做负向验证（退回旧实现断言必须 FAIL）

## 风险

改动面是契约 + IPC + worker 三处，且触碰模型选择这条热路径。**做之前先确认 IPC 通道能否复用
现有的 `getModelConfig`**，能复用就不要新增消息类型（契约四方核对成本很高）。
做不了就在本票下记 `## Blocked by (new)`，不要为了闭环而闭环。
