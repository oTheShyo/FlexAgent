# Report — Ticket 02: Tooling (lint + unit-test runner)

Status: all acceptance gates green on Windows/pwsh. No git commands run; no production source files edited (lane: `package.json` devDeps+scripts, new config files, new test files).

## 1. Tool choices

### Linter: oxlint 1.85.0 (over eslint)

- Single Rust binary, instant whole-repo runs; zero peer-dependency friction with `typescript@7.0.2` (typescript-eslint does not support TS 7 yet and would pin an older TS).
- JSONC config (`.oxlintrc.json`) supports the required *commented* exemption groups natively.
- Baseline scan found only ~39 warnings with targeted rules; eslint with its recommended sets would flag thousands of style findings, forcing exactly the mass source edits this ticket forbids.
- Config: `categories: { correctness: "error" }` plus 6 explicitly promoted rules (`no-unused-vars`, `no-unsafe-finally`, `no-useless-escape`, `no-new-array`, `no-useless-spread`, `no-useless-fallback-in-spread`), `--deny-warnings` in the script so any new violation fails the gate.
- Rejected after measuring: `suspicious`, `perf` (`no-await-in-loop` × 8 — spawn code legitimately awaits), `style` (12 206 hits), `pedantic`, `restriction` (3 616 hits). Rationale documented in the config header.

### Formatter: none (no prettier, no `format:check`)

The repo has no formatting baseline; adding `format:check` would fail immediately and fixing that means a mass reformat (forbidden by the ticket). Decision documented here and in `.oxlintrc.json`.

### Test runner: vitest 5.0.1

Specified by the ticket; runs as plain Node (no Electron window), transforms TS natively, one dependency tree.

## 2. Exemption file: `.oxlintrc.json` (commented groups, no silent ignores)

| Group | What | Why (comment in file) |
|---|---|---|
| A | `scripts/**` directory ignored | 37 standalone harness scripts, pre-existing 9× `no-unused-vars` + 2× style hits; harness code, not shipped |
| B | generated/transient trees (`out`, `dist`, `coverage`, `node_modules`, `resources`, scratch dirs) | not authored code |
| C | 10 files exempt from `no-unused-vars` | pre-existing destructured/intentional-unused patterns (incl. files concurrently edited by sibling lanes) |
| D | 8 files exempt from spread/array rules | pre-existing `no-useless-spread`/`no-new-array`/`no-useless-fallback-in-spread` |
| E | `src/main/skills/skillHub.ts` exempt from `no-unsafe-finally` | deliberate conditional throw in `finally` (line 802) |
| F | `src/main/skills/memoryLint.ts` exempt from `no-useless-escape` | escaped `-` inside secret-detection character class |
| strict | `tests/**` override | new test code gets no exemptions — strictest rules apply to everything written for this ticket |

No source file was modified to satisfy lint.

## 3. Test conventions (for tickets 03/05/11/13 regression cases)

- **Location**: repo-root `tests/` — the single documented test location. Naming: `tests/<topic>.test.ts`.
- **Environment**: `node` (vitest default here); never Electron. Config: `vitest.config.ts`, `include: tests/**/*.test.ts`.
- **Pool**: `forks` + `isolate` — one process per test file. Required because suites redirect `os.homedir()` (see below); worker threads would share `process.env`.
- **Hermetic home**: anything touching `~/.flexagent` must call `useHermeticHome(prefix)` from `tests/helpers/hermeticHome.ts` **before** the first dynamic `import()` of the module under test (paths like `SKILLS_HOME` are baked at module scope). Pattern:
  ```ts
  const { home, cleanup } = useHermeticHome('flexagent-xxx-')
  const mod = await import('../src/main/...')
  afterAll(cleanup)
  ```
- **Type imports** are static (`import type ...`), **value imports** of modules under test are the dynamic ones above.
- **Stubbing seams** (no production edits needed):
  - LLM classifier: `GateOptions.classifyBash` injection (count calls, force allow/deny/unreachable).
  - Plugin bridge: `PluginHookDeps` DI (`parseHooksContent` / `interpolate` / `runHook`).
  - Hook protocol: real child processes via `runHook({ type: 'process', command: process.execPath, args: ['-e', script] })` — no shell quoting issues on Windows.
  - State gates: `SkillManageOptions.stateReady`; tool-level gate exercised through a fake `ExtensionAPI` (`registerTool`/`on` capture).
- **Gate**: `npm run check` = lint → typecheck (node + web + **test** projects) → test. New tests must keep all three green; `tests/**` is lint-strict (no exemption escape).

## 4. Suite ↔ acceptance mapping

| Ticket line | Suite | Tests |
|---|---|---|
| 权限链五层决策顺序 + HARD_DENY 不可绕过 | `tests/permissionChain.test.ts` (18) | memory beats rules; allowance doesn't leak across parameters (`rm -rf` never inherits `npm test`); **HARD_DENY beats an allow-rule and survives `bypass`, classifier never invoked**; `hardDenyFor` pattern table; rules > heuristics (deny rule beats read-allow; deny→ask→allow collection; allow rule beats heuristic ask); heuristics > classifier (resolved calls never reach stub); classifier only for unresolved + verdict cached; unreachable classifier → ask (never allow); classifier allow + `plan` → deny via mode; plan lets reads through; bypass lifts ask but never deny |
| 技能审批 approve/reject/revert | `tests/skillWritePipeline.test.ts` (8) | approval off → immediate apply + undo entry; approval on → staged (file absent, pending listed); **approve** → lands + pending cleared + undo recorded; **reject** → discarded, skills home untouched; **revert** create → file removed; **revert** patch → previous content restored; state gate refuses writes pre-list; `skill_manage` tool end-to-end (refuse → list → create) via fake `ExtensionAPI` |
| hook 协议解析（JSON/非 JSON/退出码/超时） | `tests/hookProtocol.test.ts` (16) | stdin JSON round-trip (parsed back from stdout); non-JSON stdout = log only (`output` undefined, never context); structurally invalid JSON → `hook_output_invalid` + status failed; exit 0 structured output; **exit 2 → blockRequested + stderr reason**; exit 1 / exit 7 → recoverable `hook_exit_nonzero`; timeout → killed + `hook_timeout`; `maxOutputBytes` cap honored (`stdout.length === 1024`, `truncated`); missing binary → `spawn_error`; manifest parsing (matcher groups, timeout s→ms, malformed JSON diagnostic, missing `hooks` object, disabled skipped + invalid reported); bridge glue (stdin JSON fields asserted, `hook_block_ignored`, exit-1 diagnostic propagated, matcher skip) |
| lint 可用且通过（有注释豁免） | `npm run lint` + `.oxlintrc.json` | groups A–F above |
| test 不依赖 Electron | `vitest.config.ts` (`environment: 'node'`, `pool: 'forks'`) | pure-logic modules only |
| 门禁串联一条命令 | `npm run check` | lint && typecheck && test |

Concurrent-lane note: `tests/` also received `usage-stats.test.ts` (ticket 09) and `question-timeout.test.ts` (ticket 10) from sibling agents; all 5 files pass together under the same gate.

## 5. Exact commands + output summary

```
npm run typecheck
  tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json && tsc --noEmit -p tsconfig.test.json
  → EXIT=0   (3 projects; test project = tests/** + vitest.config.ts, strict, same options as tsconfig.node.json)

npm run lint
  oxlint --deny-warnings
  → EXIT=0   (no findings; pre-existing violations handled only via commented config exemptions)

npm test
  vitest run  (v5.0.1)
  → Test Files 5 passed (5), Tests 57 passed (57), ~3.4s, EXIT=0
     (42 tests from this ticket's 3 suites + 15 from sibling tickets 09/10)

npm run check
  lint && typecheck && test → EXIT=0   (full composite gate)
```

First-run failures fixed (test code only): TS errors in two new test files (set-vs-array indexing; `InlineExtension` union narrowing) and one over-specified assertion that targeted an unreachable `parseHookStdout` branch (non-`{` stdout is a plain log by design) — replaced with the reachable invalid-`decision` check.

## 6. Files delivered

- `.oxlintrc.json` — lint gate + commented exemption groups A–F + strict `tests/**` override
- `vitest.config.ts`, `tsconfig.test.json` — runner config + test typecheck project
- `tests/helpers/hermeticHome.ts` — hermetic `~/.flexagent` seam
- `tests/permissionChain.test.ts`, `tests/skillWritePipeline.test.ts`, `tests/hookProtocol.test.ts`
- `package.json` — devDeps (`oxlint`, `vitest`), scripts `lint`/`test`/`check`, `typecheck` extended (never weakened) with `tsconfig.test.json`
