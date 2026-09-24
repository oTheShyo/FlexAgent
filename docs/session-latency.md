# FlexAgent 会话延迟分析与修复

**分析时间：** 2026-09-24 晚
**触发问题：** 「新对话和切换对话这么慢，有时候点了还没反应」
**基线：** `1db821f`（工作区含未提交的后端 MCP 批次）
**方法：** worker 内 `FLEXAGENT_PERF` 分段计时 + V8 CPU profiler + CDP 端到端探针（`scripts/diag-latency.mjs`）

---

## 1. 结论先行

| 操作 | 修复前 | 修复后 | 倍数 |
| --- | --- | --- | --- |
| 新建对话（New chat） | **6194 ms** | **1025 ms** | 6.0× |
| 切换到未 attach 的会话（新目录） | ~6155 ms | ~2060 ms | 3.0× |
| 切换到未 attach 的会话（目录已建过 loader） | ~6155 ms | ~960 ms | 6.4× |
| 切换回已 attach 的会话 | 1 ms | 1 ms | — |
| 启动后首个请求（worker 冷启动） | 5384 ms | 5233 ms | — |
| `listSessions` | 12 ms | 1 ms | — |

**「点了没反应」是两个独立原因叠加**，二者必须分别修：

1. **内核把一次会话挂到 PI 上要 6 秒多**，而前端在这 6 秒里**不改变任何 UI 状态**——侧栏高亮和消息区都停在旧对话上。点击的视觉反馈完全缺失。
2. **首次启动还有 5.4 秒的 worker 冷启动**（PI 模块图首次 `import`），这段时间里连 worker 都还没响应。

---

## 2. 时间都花在哪

在 `attachSession()` 各阶段埋点（`FLEXAGENT_PERF=1`）后，修复前的单次 attach：

| 阶段 | 耗时 | 占比 |
| --- | --- | --- |
| `loadPi()` | 0 ms（已缓存） | — |
| MCP 握手 | 0 ms（已缓存） | — |
| **`resourceLoader.reload()`** | **3817 ms** | 63% |
| **`createAgentSession()`** | **1867 ms** | 31% |
| `bindExtensions()` | 364 ms | 6% |
| **合计** | **6048 ms** | |

同一份埋点还暴露出第二个数字：**应用启动后第一个请求花了 5384 ms，而 worker 内部实际处理只用了 0 ms**——这 5.4 秒全花在 worker 线程冷启动 + PI ESM 模块图首次编译上。

---

## 3. 三项根因

### 3.1 `resourceLoader` 每次 attach 都重建（~4.0 s）

`attachSession()` 每次都 `new DefaultResourceLoader(...)` + `reload()`。PI 的 `reload()` 会解析包图、加载每一个 extension 模块、重读项目上下文文件——而每个会话都会走一遍，即使 `cwd` 完全相同。

### 3.2 `createAgentSession()` 内部重复初始化（~1.8 s）

PI 的 `createAgentSession()` 在未收到 `modelRuntime` 时自己 `ModelRuntime.create()`（约 1.7 s）。`getDefaultAgentDir()` 与 `getAgentDir()` 返回同一目录，`auth.json`/`models.json` 解析路径一致，因此 worker 里已缓存的 runtime 可以直接复用——PI 自己的 service 层也是这么跨会话复用的。

### 3.3 worker 冷启动的首次模块加载（~5.4 s）

PI 以**未打包的 ESM 依赖图**发布（`exports.import` 指向 `dist/index.js`，内含 146 KB 的 `agent-session.js` 等）。worker 是 CJS bundle，通过动态 `import()` 加载它，每次进程重启都要重新解析编译。

---

## 4. 修复

| # | 改动 | 位置 | 收益 |
| --- | --- | --- | --- |
| 1 | **按 `cwd` 缓存 resource loader**，同目录的会话共用一个；`reloadPlugins` 清空缓存（插件资源在构造时就烘进 loader 了） | `src/main/worker.ts` | 同目录第二次 attach 省 ~4.0 s |
| 2 | **复用缓存的 `ModelRuntime`** | `src/main/worker.ts` | 省 ~1.7 s |
| 3 | **V8 编译缓存**：`enableCompileCache()` 把 PI 的字节码持久化到 `userData/compile-cache` | `src/main/index.ts` + `worker.ts` | 缩短冷启动的编译开销 |
| 4 | **让路式预热**（见 §5）：启动后趁 UI 空闲把 PI 模块图、model runtime、当前目录的 loader 全部建好 | `src/main/index.ts`、`kernel.ts`、`worker.ts` | 用户点击时命中缓存 |
| 5 | **前端乐观切换**：点击即改高亮、清空消息区、进 skeleton 态 | `src/renderer/src/hooks/useChat.ts` | 消除「点了没反应」 |

### 修复后分段

```
attachSession {"loadPi":0,"mcp":0,"resourceLoader":0,"getModelRuntime":0,
               "createAgentSession":639,"bindExtensions":329,"total":968}
createSession 端到端: 1025 ms
```

`resourceLoader` 与 `getModelRuntime` 归零即缓存命中；剩余的 ~1 s 是每个会话不可共享的 `createAgentSession` + `bindExtensions`。

---

## 5. 一个失败的尝试：预热与用户请求会互相拖慢

第一版预热无条件在启动时开跑，结果**首屏请求从 5384 ms 恶化到 7926 ms**：

```
warmup        {"loadPi":2993,"getModelRuntime":7560,"resourceLoader":3896,"total":16305}
listModels    {"getModelRuntime":5645,"getAvailable":5787,"total":11432}
attachSession {"resourceLoader":5417,"createAgentSession":3694,"bindExtensions":2081,...}
```

worker 只有**一个线程**，预热和真实请求不是并行而是交错执行，双份挂在 wall-clock 上都变长（`getAvailable` 从 20 ms 涨到 5787 ms）。

第二版加了 `waitForQuiet()` 仍然不够：它只判断「最近没有新请求」，而一次 attach 本身要跑好几秒，这段静默被误判成空闲：

```
warmup {"idleWait":2009,"loadPi":3285,...}   ← 恰好插进两个请求之间的 2s 空档
```

**最终方案**：`waitForQuiet()` 同时要求 **没有请求在飞行中**（`userRequestsInFlight === 0`）且**静默 ≥ 2 s**，loader 构建前再确认一次。预热因此严格发生在 UI 空闲之后——用户忙时它什么都不做，而不是抢资源。

```
warmup {"idleWait":2009,"loadPi":3285,"getModelRuntime":1854,"mcp":6,
        "resourceLoader":1097,"total":8251}   ← 在首屏请求完成之后才开始
```

---

## 6. 复现测量

```bash
# 1. 启动带埋点的 dev（埋点默认关闭，FLEXAGENT_PERF=1 才输出）
env -u ELECTRON_RUN_AS_NODE FLEXAGENT_PERF=1 npm run dev -- \
  -- --remote-debugging-port=9222 --disable-gpu --disable-gpu-compositing \
  --in-process-gpu --no-sandbox

# 2. 读分段（main 进程 stdout）
grep -a "\[perf\]" dev.log

# 3. 端到端计时（走 renderer 的真实 IPC 路径）
node scripts/diag-latency.mjs
```

埋点开关与实现见 `src/main/perf.ts`；`FLEXAGENT_PERF=1` 时 `attachSession` 里的 `createAgentSession` 还会输出 V8 CPU profile 的 self-time 排名。

---

## 7. 遗留

- **启动首屏的 5.2 s 没有解决**。它等于 worker 冷启动 + `loadPi` + 建第一个 loader + attach 第一个会话，是当前架构下串行不可省的固定成本。预热只能让**后续**操作变快。
- **切换到一个全新目录的会话仍需 ~2 s**（该目录的 loader 首次构建）。按目录缓存后，同目录不再重复付这个成本。
- `src/main/**` 的修复（第 1–4 项）与后端 MCP 在制品**深度耦合**（`acquireResourceLoader(cwd, mcpTools)` 的签名就依赖后端的 `mcpTools`），无法干净拆分提交，因此目前留在工作区。前端那项（第 5 项）已单独提交 `a01a414`。
