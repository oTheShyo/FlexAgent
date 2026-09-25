# 24: 插件市场补全（npx 源 + 管线可观测）

**What to build:** 插件市场补齐两件事。(1) 支持 `npx` 源类型安装（gap-audit B9），与既有 URL/GitHub/归档源并列，沿用原子安装与版本比较语义。(2) 市场安装管线接入可观测体系：下载/校验/解压/原子切换各阶段产生事件并进 pipeline JSONL（callSource 归因），安装失败可诊断到阶段。搜索/安装/卸载/回滚既有行为不回归。

**Blocked by:** 01 (落库未提交子系统)

**Status:** done — WorkBuddy (observability track), 2026-09-26

- [x] npx 源类型可安装、可升级、可卸载，与其它源行为一致
- [x] 安装管线各阶段产生可观测事件，pipeline JSONL 可看到完整安装轨迹
- [x] 安装失败（网络/校验/解压）诊断到具体阶段，UI 报错可理解
- [x] 原子安装语义保持：失败不留下半装状态（回滚可用）
- [x] 既有市场验收脚本全绿并新增 npx 源用例

## 实现

- `src/main/marketplaceNpm.ts`（新）：npm/npx 源解析——metadata → tarball 下载（重定向≤5、200MB 上限）→ integrity 校验（sha512/sha256 base64）→ `tar x strip:1` → 可选子路径（resolveInside 防逃逸）。`FLEXAGENT_NPM_REGISTRY` 覆盖 registry。各阶段 `observeNpmStage` 打点。
- `src/main/pluginMarketplace.ts`：`resolvePluginSourceRoot` 新增 `npm`/`npx` 分支（pip 仍拒绝）；4 处 `activateDirectoryAtomically` 换成 `activateAtomicallyObserved`（"stage marketplace"/"activate plugin" 打点）；`installFromMarketplace` 拆观察外壳 + Inner（install 成败打点）。
- `scripts/accept-marketplace.mjs`：新增 npx/npm 测试组——真实 tgz + 本地 registry server，覆盖 npm 安装、npx 固定版本、integrity mismatch 拒绝（PLUGIN_DOWNLOAD_FAILED）、404 拒绝（PLUGIN_NOT_FOUND）。

## 修复的两个真实缺陷

1. **marketplace.json 伪造 `raw` 字段静默损坏市场**：`parseMarketplaceManifest` 的快速路径 `isPluginMarketplaceManifest` 见 `isRecord(value.raw)` 即原样返回，导致 `manifest.raw` 指向外部 JSON 里的任意对象；`stageMarketplaceDirectoryPlugins` 落盘的就是这个对象（实测 `{}`），回读 parse 失败 → "Marketplace not found"。修复：parse 时强制 `raw: value`（磁盘原始 JSON），外部伪造字段被覆盖。
2. **npm tarball 解压根路径错位**：`tarExtract` 用 `strip:1` 剥掉 `package/` 根后，root 仍指向 `workDir/package`（不存在）→ "did not yield a usable directory"。修复：strip:1 后 root 即 workDir。
3. （补）`verifyNpmIntegrity` 抛错早于打点，失败时缺 `download+verify ok=false` 事件——补 try/catch 阶段级失败事件。

## 验收证据

`accept-marketplace.mjs`：**PASS (61/61)**（含新增 npm/npx 组）。

pipeline.jsonl 完整安装轨迹（成功 + integrity 失败，一次真实运行摘录）：

```
marketplace  stage=stage marketplace               ok=true   278ms
marketplace  stage=npm npm-demo resolve           ok=true    18ms  note=version 2.5.0
marketplace  stage=npm npm-demo download+verify   ok=true     5ms  note=250 bytes
marketplace  stage=npm npm-demo extract           ok=true    18ms
marketplace  stage=activate plugin                ok=true   439ms
marketplace  stage=install                        ok=true  1361ms  note=npm-demo@npmmkt
marketplace  stage=npm npm-demo resolve           ok=true     2ms  note=version 9.9.9
marketplace  stage=npm npm-demo download+verify   ok=false     1ms  note=npm tarball integrity mismatch for npm-demo: expected sha512 …, got …
marketplace  stage=install                        ok=false    12ms  note=…integrity mismatch…
```

失败诊断链：版本不存在 → `resolve` 阶段后 PLUGIN_NOT_FOUND；字节被篡改 → `download+verify` ok=false + PLUGIN_DOWNLOAD_FAILED（消息含 expected/got digest）。
