import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Point `os.homedir()` at a throwaway directory for the current process.
 *
 * Modules under test bake `~/.flexagent/...` paths in at module scope
 * (`SKILLS_HOME`, `PERMISSIONS_FILE`, ...), so the env vars MUST be set before
 * the first dynamic `import()` of those modules — call this first in the test
 * file, then `await import(...)`.
 *
 * Node resolves `homedir()` lazily from USERPROFILE (Windows) / HOME (POSIX)
 * on every call, so no process restart is needed. With vitest's `forks` pool
 * each test file runs in its own process, so the override cannot leak across
 * files either.
 */
export function useHermeticHome(prefix: string): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), prefix))
  process.env.USERPROFILE = home
  process.env.HOME = home
  return {
    home,
    cleanup: (): void => {
      rmSync(home, { recursive: true, force: true })
    }
  }
}
