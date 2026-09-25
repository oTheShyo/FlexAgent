import { defineConfig } from 'vitest/config'

/**
 * Test conventions (ticket 02 — tooling/lint/unit tests).
 *
 * Location: repo-root `tests/` directory (one documented location for the whole
 * repo). Electron app sources live under `src/` and are never executed here —
 * suites import individual pure-logic modules (permission gate, skill manager,
 * hook runner) and run them as plain Node code.
 *
 * Environment: `node`. None of the covered code touches the DOM.
 *
 * Pool: `forks`. Several suites redirect `os.homedir()` (via USERPROFILE/HOME)
 * before dynamically importing modules that bake `~/.flexagent/...` paths at
 * module scope. A fresh process per test file guarantees that environment seam
 * can never leak into another file (worker threads would share `process.env`).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    isolate: true,
    // Windows process spawns (hook suite) and first-import transpilation can be slow.
    testTimeout: 20_000,
    hookTimeout: 20_000
  }
})
