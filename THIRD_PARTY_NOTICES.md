# Third-Party Notices

This file lists third-party source code incorporated into FlexAgent, with provenance and the modifications applied.

## ZCode marketplace stack

- **Upstream**: https://github.com/zai-org/ZCode
- **Commit SHA**: `328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f`
- **License**: Apache License 2.0
- **Upstream package path**: `apps/zcode-cli/packages/adapters/src/plugins/`

The following FlexAgent files were ported from the upstream paths listed below.
Each entry notes the COPY vs ADAPT classification from the porting matrix and the concrete modifications applied in this repository.

| FlexAgent file | Upstream source (same SHA) | Matrix | Modifications |
|---|---|---|---|
| `src/main/pluginMarketplace.ts` | `marketplace.ts` | COPY C1 + C5 | Load switch extended with `.flex-plugin/marketplace.json` candidate; X7 official seed/guards omitted; `settings` load case dropped; installed-record writes go through the existing `PluginRegistry` (`installed.json`) instead of a second authority file; `${userConfig}` interpolation (C6) retained; git invocation uses plain `process.env` (`PLUGIN_GIT_BINARY` override) rather than upstream settings plumbing; zero-comment rewrite. |
| `src/main/marketplaceGithub.ts` | `github-archive-source.ts` | COPY C2 | Near-verbatim; header comment removed (repo zero-comment rule); `fetch` uses native undici with manual redirect handling. |
| `src/main/marketplaceZip.ts` | `zip-source.ts` | COPY C3 | `yauzl` replaced with a pure-Node zip reader (EOCD + central directory + `zlib.inflateRawSync`); CRC-32 via `zlib.crc32`; native `fetch` with manual redirects; path-traversal (`..`), encrypted-entry, and symlink rejection retained. |
| `src/main/marketplaceAtomic.ts` | `atomic-directory.ts` | COPY C4 | Near-verbatim; comments removed; Node `fs/promises` APIs retained. |
| `src/main/marketplaceTemplate.ts` | interpolation portion of `marketplace.ts` (C6) | COPY C6 | Extracted into a standalone module; raw-environment and official-auth branches removed; `FLEX_*` aliases added alongside `userConfig` keys; template file is this module, not the app's `userConfig.ts` (avoids collision with the user-config track). |
| `src/main/marketplaceHelpers.ts` | `helpers.ts` + `source-errors.ts` | COPY C10 | Source-error redaction mapped to this app's `ContractError` codes (`PLUGIN_SOURCE_INVALID`, `PLUGIN_DOWNLOAD_FAILED`, `PLUGIN_PATH_INVALID`). |
| `src/main/marketplaceVersionCompare.ts` | `version-compare.ts` | COPY (support) | Minimal internal semver-ish comparator; upstream `semver` dependency replaced with a dependency-free implementation. |
| `src/main/marketplaceIpc.ts` | — (new) | ADAPT | Electron `ipcMain.handle` surface mirroring this app's existing IPC guard pattern (`ipc.ts` left untouched); duplicated guard is intentional to keep `ipc.ts` out of the edit set. |

Ported logic is host-side only (main process). No PI/kernel protocol types were introduced into `src/shared/`.

## ZCode hooks stack (P2c)

- **Upstream**: https://github.com/zai-org/ZCode
- **Commit SHA**: `328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f`
- **License**: Apache License 2.0
- **Upstream package paths**: `apps/zcode-cli/packages/adapters/src/plugins/`, `apps/zcode-cli/packages/core/src/hooks/`

| FlexAgent file | Upstream source (same SHA) | Matrix | Modifications |
|---|---|---|---|
| `src/main/userConfig.ts` | `mcp.ts` (TEMPLATE_PATTERN, resolveTemplate) | COPY C6 (adapted) | Official-auth branch removed; host contracts shimmed; zero-comment rewrite. |
| `src/main/hookSources.ts` | `hook-sources.ts` | COPY C7 (adapted) | Zero-comment rewrite; diagnostics mapped to this app's `PluginDiagnostic` codes. |
| `src/main/pluginBridge.ts` (`matchesHookMatcher`) | `core/src/hooks/output.ts` (matcher fragment) | COPY (fragment) | Embedded in an original module; no license header per repo zero-comment rule — attribution recorded here. |
| `src/main/hooks/hookRunner.ts` | `core/src/hooks/runner.ts`, `configured-runner*.ts` + `packages/shared/src/workspace-hook-config.ts` L7-8 (`DEFAULT_WORKSPACE_HOOK_TIMEOUT_MS=60_000`, `MAX_OUTPUT_BYTES=32_768`) | ADAPT (C8) | Rewritten for worker-thread host; timeout/output constants retained; zero-comment. |

## Other third-party components

FlexAgent's existing dependency tree (Electron, React, Vite, etc.) is declared in `package.json` and `package-lock.json` and is out of scope for this file; this notice covers source code ported from external repositories, which does not appear in the lockfile as a package dependency.
