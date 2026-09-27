# FlexAgent

A desktop coding agent — an Electron app that drives a coding model against your
workspace with multi-agent roles, a plugin marketplace, MCP servers, skills, and
a permission gate that decides what the agent is allowed to touch.

![FlexAgent](resources/logo.png)

> **Status:** `0.1.0` — early, actively developed. Expect rough edges.

---

## What it does

- **Chat-driven coding** in a real workspace: read, search, edit, run commands,
  with diffs rendered inline.
- **Multi-agent roles** — delegate to named subagents (`researcher`, `reviewer`,
  …) or define your own in Markdown, each with its own persona and tool
  whitelist.
- **Permission gate** — every tool call is classified before it runs: session
  memory, user rules, heuristics, an optional shell classifier, and per-mode
  rails (`default` / `plan` / `acceptEdits` / `bypass`). Irreversible command
  shapes and credential paths are refused outright.
- **Plugins & MCP** — install plugins from a marketplace, connect Model Context
  Protocol servers; third-party tools are never auto-trusted by name.
- **Skills** — Claude-style skill folders that extend what the agent can do.
- **Integrated terminal** (xterm + node-pty).
- **Local-first state** — settings, sessions, and agent definitions live on your
  machine.

---

## Requirements

| | |
|---|---|
| **Node.js** | `>= 20` (developed on `24.x`) |
| **OS** | Windows, macOS, or Linux for **development**. The packaged installer script currently targets **Windows x64** only. |
| **Build tools** | Required for the native `node-pty` module — see below. |
| **A model provider** | An API key for Anthropic, OpenAI, or any OpenAI-compatible endpoint. **Required to run the agent** (the app launches without one, but turns will fail). |

### Native build tools

`node-pty` is a native addon and must be compiled for your platform.

- **Windows:** Visual Studio Build Tools with the "Desktop development with C++"
  workload, plus Python 3.
- **macOS:** Xcode Command Line Tools — `xcode-select --install`.
- **Linux:** `build-essential` and `python3`, plus your distro's Electron
  runtime libraries.

The `postinstall` script runs `electron-rebuild -f -w node-pty` automatically to
compile it against the bundled Electron. If that step is skipped or fails, run
it manually:

```bash
npm run rebuild
```

---

## Run it locally (from source)

```bash
# 1. Clone
git clone https://github.com/oTheShyo/FlexAgent.git
cd FlexAgent

# 2. Install (postinstall rebuilds node-pty for Electron)
npm install

# 3. Start the app in development mode
npm run dev
```

`npm run dev` launches Electron with hot reload for the renderer.

### Configure a model provider

On first launch, open **Settings → Models** and add a provider and API key.
Keys are stored through the OS credential vault (encrypted at rest), not in
plain text. Once a provider and model are set, start a session and send a
message.

---

## Build a distributable

```bash
npm run build     # compile main / preload / renderer into out/
npm run dist      # build + package a Windows x64 NSIS installer into dist/
```

The installer is written to `dist/FlexAgent-<version>-setup.exe`, along with a
`resources/logo.png`-based icon and the usual Electron Builder artifacts.

Packaging details — mirror environment variables (useful behind a slow GitHub
connection), install/uninstall behaviour, and the unsigned-installer SmartScreen
prompt — are documented in [`docs/packaging.md`](docs/packaging.md).

---

## Verify it

```bash
npm run check     # lint + typecheck (node/web/test) + unit tests
```

This is the gate the project is developed against: `oxlint --deny-warnings`,
three `tsc --noEmit` passes, and the Vitest suite. Run it before opening a PR.

Individual steps:

```bash
npm run lint
npm run typecheck
npm test
```

`scripts/` contains additional QA and end-to-end probe harnesses (walkthroughs,
security diagnostics, marketplace/credential-vault checks) that exercise the
packaged app. They are manual by design and are not part of `npm run check`.

---

## Project layout

```
src/
  main/        Electron main process — agent runtime, IPC, permission gate,
               plugins, MCP, marketplace, sessions, terminal, security
  preload/     Context-isolated bridge (named functions only; no raw ipcRenderer)
  renderer/    React + Tailwind UI
  shared/      Types and contracts shared across processes
tests/         Vitest unit tests
scripts/       QA, probes, and walkthrough harnesses
docs/          Design and architecture notes
```

Design documents for individual subsystems (multi-agent, plugins, security
architecture, observability, packaging, …) live in [`docs/`](docs/).

---

## Security notes

- The renderer runs with `contextIsolation` on and `nodeIntegration` off, under
  a strict Content-Security-Policy; all IPC senders are validated.
- Secrets are stored in the OS credential vault and scrubbed from logs.
- The permission gate refuses destructive command shapes and credential-store
  writes regardless of mode, and never auto-trusts a third-party tool by its
  name.
- The packaged installer is **unsigned**, so Windows SmartScreen will warn on
  first run. See `docs/packaging.md` for the expected prompt and how to build
  with a signing certificate.

---

## License

MIT — see [`LICENSE`](LICENSE).

This project is built on and adapts other open-source work:

- Source ported from [ZCode](https://github.com/zai-org/ZCode) (Apache-2.0) —
  the plugin marketplace stack, hooks, and MCP lifecycle — is itemised, with the
  exact modifications, in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
- UI components adapted from [lnkiai/m3e-canvas](https://github.com/lnkiai/m3e-canvas)
  (MIT), which in turn ports Material Design loading indicators (Apache-2.0,
  Google LLC) — see [`NOTICE`](NOTICE).
- The agent runtime depends on
  [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
  (MIT). Its license travels with the package in `node_modules`; the rest of the
  dependency tree (Electron, React, Vite, …) is declared in `package.json` and
  `package-lock.json`.
