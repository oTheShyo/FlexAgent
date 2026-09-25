# Report — Ticket 08: 推理强度切换 (reasoning-effort tiers)

Status: all five acceptance points evidenced with real-model runs on Windows/pwsh. No git commands run; lane boundaries respected (`package.json`, `src/main/agents/**`, `scripts/**`, `docs/multi-agent.md` untouched; Composer edits confined to the selector region next to the model chip).

## 1. Design: Scheme T (tier → PI thinking level → wire parameter)

The composer offers exactly the three tiers the ticket names — **低 / 高 / 最高** — plus **关 (off)** as a non-tier escape hatch. Tiers are a renderer/worker concept; PI sessions speak in per-model `ThinkingLevel`s (`off … max`). One shared module owns the mapping so chip, menu, `ModelConfig.effort` and llm-calls rows can never disagree:

| Tier | Resolution against the model's level ladder | glm-5.3-flash (off/minimal/low/medium/high) | wire (openai-completions) |
|---|---|---|---|
| 低 | first of `low` → `minimal`, else weakest non-off | `low` | `reasoning_effort: "low"` |
| 高 | first of `high` → `medium` strictly between the two ends, else first strictly-between, else **disabled with reason** | `medium` | `reasoning_effort: "medium"` |
| 最高 | strongest non-off level | `high` | `reasoning_effort: "high"` |
| 关 | not a tier; sets level `off` | `off` | field omitted |

Capability-driven disable: a model declaring only `["off"]` (reasoning: false or empty ladder) yields all three tiers `available: false` with `EFFORT_UNSUPPORTED_REASON`; a two-rung ladder disables only 高 with `highUnavailableReason(levels)` listing the actual rungs; no model selected → all disabled with `EFFORT_NO_MODEL_REASON`. The menu shows the reason line per item; the chip carries it as `title`/`aria-label`. Never faked: `effortForLevel` is exact-match only, so `off` and raw levels picked in the advanced model menu map to `effort: null`.

## 2. Capability metadata chain

```
~/.pi/agent/models.json  provider USTC { baseUrl, api: openai-completions, models[{ id, name, reasoning, compat }] }
        │  (reasoning / thinkingLevelMap only — apiKey never read into configs)
        ▼
PI getSupportedThinkingLevels(model)  ← pi-ai dist/models.js (clampThinkingLevel, getAvailableThinkingLevels)
        ▼
worker readModelConfig(session) → ModelConfig.availableThinkingLevels  (src/main/worker.ts:1267)
        ▼
resolveEffortTiers(levels) → [{effort, level, available, reason?}]      (src/shared/reasoningEffort.ts:136)
        ▼
renderer chip/menu (Composer.tsx)  ·  worker ModelConfig.effort = effortForLevel(thinkingLevel, levels)
```

## 3. Wire evidence (acceptance 2 + 4)

### 3.1 OpenAI-style custom model — real HTTP, exact app path

The app's request path is `sdk.js streamFn → modelRuntime.streamSimple → openai-completions.streamSimple`, which maps `options.reasoning` → `clampThinkingLevel` → `reasoning_effort`. Harness `effort-wire.mjs` calls the same `streamSimple` with a fetch probe; model `USTC/glm-5.3-flash`, endpoint `https://api.llm.ustc.edu.cn/v1/chat/completions`, all runs `start..done`, `errText: null`:

| thinkingLevel sent | request body `reasoning_effort` | thinking events |
|---|---|---|
| `low` | `"low"` | yes |
| `medium` (tier 高) | `"medium"` | yes |
| `high` (tier 最高) | `"high"` | yes |
| `undefined` (关) | *field absent* | — |

### 3.2 Anthropic-style custom model — parameter family differs, mapping still ours

Harness `effort-wire-anthropic.mjs` runs the same tiers through `anthropic-messages.streamSimple` (endpoint `/v1/messages?beta=true`), proving the tier→level choice lands on the Anthropic parameter family correctly:

| tier | mapped level | request body |
|---|---|---|
| 低 | `low` | `thinking: { type: "enabled", budget_tokens: 2048 }` |
| 高 | `medium` | `thinking: { type: "enabled", budget_tokens: 8192 }` |
| 最高 | `high` | `thinking: { type: "enabled", budget_tokens: 15360 }` (= 16384 cap − 1024 answer room) |
| 关 | `off` | `thinking: { type: "disabled" }` |

No `reasoning_effort` key ever appears on this family. Providers with no reasoning parameter degrade gracefully: the model never declares a ladder → tiers disabled with reason → no reasoning parameter composed.

### 3.3 llm-calls.jsonl rows (acceptance 2, 5)

Real worker runs (headless driver, `out/main/worker.js`):

```
session effort-evidence2-410c4f1b   model USTC/glm-5.3-flash
  {"thinkingLevel":"low","effort":"low","ok":true}
  {"thinkingLevel":"medium","effort":"high","ok":true}
  {"thinkingLevel":"high","effort":"max","ok":true}      ← 3 distinct wire values, all ok
session effort-evidence-f803de16    model USTC/qwen-chat (levels: ["off"])
  {"thinkingLevel":"off","effort":null,"ok":true} ×4     ← graceful degradation, no fake effort
```

Emission site: `observeChatMessage` computes `cfg = readModelConfig(session)` and writes `thinkingLevel` + `effort` on every row (`src/main/worker.ts:1196,1212`).

## 4. Persistence + new-session default policy (acceptance 3)

**Mechanism (PI-owned, no invented storage):** `setThinkingLevel(level, { persist: false })` (`worker.ts:2408`) appends a `thinking_level_change` entry to the PI transcript (`agent-session.js:1762`) and never writes a global default. On reopen, `sdk.js:118-121` reads the entry back and `clampThinkingLevel` re-validates it against the current model.

**Measured** (harness `effort-reopen.mjs`, session `effort-reopen-*`):

```json
{
  "freshSessionDefault": { "thinkingLevel": "off", "effort": null },
  "beforeDispose":       { "thinkingLevel": "high", "effort": "max" },
  "piSessionFile": "~/.pi/agent/sessions/--C--Users-HP-AppData-Local-Temp-opencode--/2026-09-25T19-37-40-247Z_01a0da12-….jsonl",
  "afterReopen":          { "thinkingLevel": "high", "effort": "max" },
  "restored": true
}
```

Transcript contents of a tier-switching session show the mechanism directly: `session → model_change → thinking_level_change off → … → low → messages → medium → messages → high`. Caveat found while testing: PI buffers transcript entries until the first assistant message flushes (`session-manager.js:_persist`), so persistence is only observable after one real turn — same behavior PI has for model changes; not specific to this ticket.

**New-session default policy (recorded here as the ticket requires):**

1. A fresh session's tier = PI's own default-thinking-level chain, resolved in `sdk.js:116-139`: explicit create-session option → existing transcript's last `thinking_level_change` → per-model default in settings.json → global default → `DEFAULT_THINKING_LEVEL`, finally `clampThinkingLevel(model, …)` so the default can never exceed the model's ladder.
2. Observed on this machine (no default configured): **new session → level `off` → `effort: null` → chip reads `推理 · 关`** — i.e. new sessions send no reasoning parameter until the user picks a tier.
3. Tier picks are **per-session only** (`persist: false`): they never mutate settings.json, so a pick in session A does not leak into session B's default.

## 5. Gates (exact commands + output)

```
npm run typecheck
  → tsconfig.node.json EXIT=0
    tsconfig.web.json  EXIT=1 — single error src/renderer/src/hooks/useChat.ts(46,12)
      TS2304 Cannot find name 'QuestionOption'   ← sibling lane's in-flight file, not touched by this ticket
    tsconfig.test.json EXIT=0   (run standalone after the chain stopped)
npm run lint        (oxlint --deny-warnings)        → EXIT=0
npm run test        (vitest run v5.0.1)             → Test Files 6 passed (6), Tests 70 passed (70), EXIT=0
                                                      (13 from tests/reasoningEffort.test.ts, 57 pre-existing/sibling)
npx tsc --noEmit -p tsconfig.test.json               → EXIT=0
```

Suite ↔ acceptance: `tests/reasoningEffort.test.ts` (13) covers tier resolution on full/partial/off-only/empty ladders (3 distinct values for glm-shaped ladders), 高-disable reason content, `effortForLevel` exact-match/null semantics (`off`, unmapped, undefined), label/gloss tables, `normalizeThinkingLevels` dedupe + ladder order, and the no-model/unsupported reason constants.

## 6. Files delivered (regions)

| File | Region / change |
|---|---|
| `src/shared/reasoningEffort.ts` **(new, 189 L)** | `ReasoningEffort`, `REASONING_EFFORTS/LABELS/GLOSS/OFF_LABEL` (低/高/最高/关), `EFFORT_NO_MODEL_REASON`, `EFFORT_UNSUPPORTED_REASON`, `EffortOption`, `normalizeThinkingLevels` (95), `hasReasoningSupport` (107), `resolveEffortTiers` (136), `effortForLevel` (176), `describeEffort` (187); module header documents Scheme T |
| `src/shared/contract/index.ts` | :10 `import type { ReasoningEffort }`; :441 `export * from '../reasoningEffort'`; :461 `ModelConfig.effort: ReasoningEffort \| null` (null = off/unmapped) |
| `src/main/observability.ts` | :26 type imports; :135-137 `LlmCallObservation.thinkingLevel? / effort?` with doc comments |
| `src/main/worker.ts` | :8 import `effortForLevel`; `readModelConfig` :1267-1281 returns `effort`; `observeChatMessage` :1196/:1212 emits `thinkingLevel`+`effort`; call sites :1731/:1739 pass `host.session` |
| `src/renderer/src/api/mock.ts` | :4/:39 imports; :143-144 `mockEffort`; ModelConfig seeds :719 (new), :752 (setModel), :769 (setThinkingLevel) |
| `src/renderer/src/components/Composer.tsx` | :44-50 imports; :1094-1111 derived (`effortTiers/effortSupported/currentEffort/effortReason/effortChipLabel`); chip `composer-effort-chip` :~1290-1327 (`data-effort`, `data-thinking-level`, disabled title/aria carries the reason); menu `composer-effort-menu` :1328-1391 (关 item + per-tier items `composer-effort-option-<effort>` with `→ level` and reason line). Model chip/menu below :1392 untouched |
| `tests/reasoningEffort.test.ts` **(new, 136 L)** | 13 tests, all green |

Concurrent-lane notes: Composer.tsx is also edited by the sibling selector lane (edits kept to the selector container/menu region); sibling 02 owns `tsconfig.test.json`/`.oxlintrc.json` — used as-is, not modified. `docs/observability.md` was deliberately **not** edited: the file is GBK-encoded and a UTF-8 write would corrupt it; an ASCII row under §8 for `thinkingLevel`/`effort` is a safe follow-up done via encoding-aware tooling.

## 7. Acceptance checklist

- [x] **档位选择器在模型选择处，随能力声明变化** — chip `composer-effort-chip` sits left of the model chip; tiers derived from `ModelConfig.availableThinkingLevels`; unsupported → disabled + reason (title/menu reason line); no model → disabled with `EFFORT_NO_MODEL_REASON`. Covered by 13 unit tests.
- [x] **请求体携带 reasoning 参数，llm-calls.jsonl 可验证** — wire bodies `reasoning_effort low/medium/high`, absent for off (§3.1); llm-calls rows show `thinkingLevel` + `effort` triples `low/low, medium/high, high/max` all `ok:true` (§3.3).
- [x] **随会话配置持久，重开生效；新会话默认策略有记录** — reopen restored `high/max` via `openSession`+transcript (§4); default policy recorded in §4 (fresh → `off`/`null` → `推理 · 关`, PI default chain, per-session only).
- [x] **OpenAI 风格与 Anthropic 风格各自正确映射；无参数 provider 优雅降级** — §3.1 `reasoning_effort`, §3.2 `thinking.budget_tokens` 2048/8192/15360 + `disabled` for off; no-ladder model → all tiers disabled, no reasoning key, `effort: null` rows (§3.3 qwen-chat).
- [x] **至少一个真实模型实测三档请求差异有据可查** — `USTC/glm-5.3-flash`: three distinct wire values on both parameter families + three distinct llm-calls rows; harness outputs in `C:\Users\HP\AppData\Local\Temp\opencode\effort-wire.mjs`, `effort-wire-anthropic.mjs`, `effort-evidence-2.mjs`, `effort-reopen.mjs`.

Gate caveat for the orchestrator: `tsconfig.web.json` currently fails solely on the sibling lane's `useChat.ts` `QuestionOption` error; every project/file this ticket owns typechecks clean.
