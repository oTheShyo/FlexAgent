import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'
import {
  LEAST_PRIVILEGE,
  type PluginCapabilities
} from '../src/shared/contract'
import {
  buildSandboxEnv,
  capabilityRequest,
  defaultCapabilitiesFor,
  effectiveCapabilities,
  grantCapabilities,
  isPathAllowed,
  mergeCapabilities,
  needsConsent,
  revokeGrant,
  resolveSandboxCwd,
  sandboxRoots,
  setCapabilities
} from '../src/main/sandbox'
import { boundaryViolation, runHook } from '../src/main/hooks/hookRunner'
import { extractHookEntries } from '../src/main/hookSources'

const WORKSPACE = resolve('/repo/project')
const PLUGIN_ROOT = resolve('/plugins/demo')
const PLUGIN_DATA = resolve('/data/demo')

describe('defaultCapabilitiesFor', () => {
  it('gives a marketplace plugin the minimum — nobody read it first', () => {
    expect(defaultCapabilitiesFor('marketplace')).toEqual(LEAST_PRIVILEGE)
    expect(defaultCapabilitiesFor('marketplace').fs).toBe('plugin-data')
  })

  it('gives hand-installed plugins the workspace, and still no credentials', () => {
    expect(defaultCapabilitiesFor('local')).toEqual({
      fs: 'workspace',
      env: 'minimal',
      network: false
    })
    expect(defaultCapabilitiesFor('bundled').env).toBe('minimal')
  })
})

describe('buildSandboxEnv', () => {
  const parent = {
    PATH: '/usr/bin',
    OPENAI_API_KEY: 'sk-secret',
    FLEXAGENT_HOME: '/home/me/.flexagent',
    USERPROFILE: 'C:\\Users\\me'
  }

  it('hands over the allowlist, not the parent environment', () => {
    const env = buildSandboxEnv({
      capabilities: { fs: 'workspace', env: 'minimal', network: false },
      parent
    })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.FLEXAGENT_HOME).toBeUndefined()
    expect(env.USERPROFILE).toBeUndefined()
  })

  it('lets the documented overlay through — that is how a hook learns the project', () => {
    const env = buildSandboxEnv({
      capabilities: { fs: 'workspace', env: 'minimal', network: false },
      parent,
      overlay: { FLEX_PROJECT_DIR: WORKSPACE }
    })
    expect(env.FLEX_PROJECT_DIR).toBe(WORKSPACE)
  })

  it('inherit means inherit, and the overlay still wins', () => {
    const env = buildSandboxEnv({
      capabilities: { fs: 'workspace', env: 'inherit', network: false },
      parent,
      overlay: { OPENAI_API_KEY: 'from-overlay' }
    })
    expect(env.OPENAI_API_KEY).toBe('from-overlay')
    expect(env.USERPROFILE).toBe('C:\\Users\\me')
  })
})

describe('resolveSandboxCwd', () => {
  it('starts a plugin-data hook in its own data directory', () => {
    expect(
      resolveSandboxCwd({
        capabilities: LEAST_PRIVILEGE,
        workspaceCwd: WORKSPACE,
        pluginDataPath: PLUGIN_DATA
      })
    ).toBe(PLUGIN_DATA)
  })

  it('starts a workspace hook in the workspace', () => {
    expect(
      resolveSandboxCwd({
        capabilities: { fs: 'workspace', env: 'minimal', network: false },
        workspaceCwd: WORKSPACE,
        pluginDataPath: PLUGIN_DATA
      })
    ).toBe(WORKSPACE)
  })

  it('falls back to the data directory when a no-file hook has one', () => {
    expect(
      resolveSandboxCwd({
        capabilities: { fs: 'none', env: 'minimal', network: false },
        workspaceCwd: WORKSPACE,
        pluginDataPath: PLUGIN_DATA
      })
    ).toBe(PLUGIN_DATA)
  })
})

describe('sandboxRoots', () => {
  it('workspace scope covers the workspace and the plugin itself', () => {
    const roots = sandboxRoots({
      capabilities: { fs: 'workspace', env: 'minimal', network: false },
      workspaceCwd: WORKSPACE,
      pluginRoot: PLUGIN_ROOT,
      pluginDataPath: PLUGIN_DATA
    })
    expect(roots).toEqual([WORKSPACE, PLUGIN_ROOT, PLUGIN_DATA])
  })

  it('plugin-data scope does not include the workspace', () => {
    const roots = sandboxRoots({
      capabilities: LEAST_PRIVILEGE,
      workspaceCwd: WORKSPACE,
      pluginRoot: PLUGIN_ROOT,
      pluginDataPath: PLUGIN_DATA
    })
    expect(roots).not.toContain(WORKSPACE)
    expect(roots).toContain(PLUGIN_DATA)
  })

  it('no-file scope gets no roots at all', () => {
    expect(
      sandboxRoots({
        capabilities: { fs: 'none', env: 'minimal', network: false },
        workspaceCwd: WORKSPACE,
        pluginRoot: PLUGIN_ROOT
      })
    ).toEqual([])
  })
})

describe('isPathAllowed', () => {
  const roots = [WORKSPACE, PLUGIN_ROOT]

  it('accepts a path inside a root, and the root itself', () => {
    expect(isPathAllowed(join(WORKSPACE, 'src', 'a.ts'), roots)).toBe(true)
    expect(isPathAllowed(WORKSPACE, roots)).toBe(true)
  })

  it('rejects a sibling directory that merely shares a prefix', () => {
    expect(isPathAllowed(`${WORKSPACE}-evil`, roots)).toBe(false)
    expect(isPathAllowed(resolve('/repo/other'), roots)).toBe(false)
  })

  it('rejects an empty path — nothing to allow', () => {
    expect(isPathAllowed('', roots)).toBe(false)
  })
})

describe('needsConsent and mergeCapabilities', () => {
  const baseline = defaultCapabilitiesFor('marketplace')

  it('a declaration at or below the baseline needs nobody', () => {
    expect(needsConsent(baseline, baseline)).toBe(false)
    expect(needsConsent({ fs: 'none', env: 'minimal', network: false }, baseline)).toBe(false)
  })

  it('network, a full environment, or the workspace all need a person', () => {
    expect(needsConsent({ ...baseline, network: true }, baseline)).toBe(true)
    expect(needsConsent({ ...baseline, env: 'inherit' }, baseline)).toBe(true)
    expect(needsConsent({ ...baseline, fs: 'workspace' }, baseline)).toBe(true)
  })

  it('merges a partial declaration over the baseline', () => {
    expect(mergeCapabilities(baseline, { network: true })).toEqual({
      fs: 'plugin-data',
      env: 'minimal',
      network: true
    })
    expect(mergeCapabilities(baseline, undefined)).toEqual(baseline)
  })
})

describe('grants', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'flexagent-sandbox-'))
    process.env.FLEXAGENT_HOME = home
  })

  afterEach(() => {
    delete process.env.FLEXAGENT_HOME
    rmSync(home, { recursive: true, force: true })
  })

  const declared: Partial<PluginCapabilities> = { fs: 'workspace', env: 'inherit' }

  it('an unblessed marketplace plugin asking for more runs at the minimum', () => {
    expect(effectiveCapabilities('demo@marketplace', 'marketplace', declared)).toEqual(
      LEAST_PRIVILEGE
    )
  })

  it('once granted, it runs with what was granted', () => {
    const granted: PluginCapabilities = { fs: 'workspace', env: 'inherit', network: false }
    grantCapabilities('demo@marketplace', granted)
    expect(effectiveCapabilities('demo@marketplace', 'marketplace', declared)).toEqual(granted)
  })

  it('revoking puts it back on the baseline', () => {
    grantCapabilities('demo@marketplace', { fs: 'workspace', env: 'inherit', network: false })
    revokeGrant('demo@marketplace')
    expect(effectiveCapabilities('demo@marketplace', 'marketplace', declared)).toEqual(
      LEAST_PRIVILEGE
    )
  })

  it('a local plugin needs no grant for its own baseline', () => {
    expect(effectiveCapabilities('demo@local', 'local', undefined)).toEqual({
      fs: 'workspace',
      env: 'minimal',
      network: false
    })
  })

  it('setCapabilities grants, and null takes it back', () => {
    const granted: PluginCapabilities = { fs: 'workspace', env: 'minimal', network: true }
    expect(setCapabilities('demo@marketplace', 'marketplace', granted)).toEqual(granted)
    expect(setCapabilities('demo@marketplace', 'marketplace', null)).toEqual(LEAST_PRIVILEGE)
  })

  it('capabilityRequest describes what a person is agreeing to', () => {
    const request = capabilityRequest('demo@marketplace', 'marketplace', {
      fs: 'workspace',
      env: 'inherit'
    })
    expect(request.needsGrant).toBe(true)
    expect(request.granted).toBe(false)
    expect(request.capabilities).toEqual(LEAST_PRIVILEGE)
    expect(request.requested.fs).toBe('workspace')
    expect(request.lines).toHaveLength(3)
    expect(request.lines[0]).toContain('project')
    expect(request.lines[1]).toContain('credentials')
  })

  it('a plugin that asks for nothing is not a decision', () => {
    const request = capabilityRequest('demo@local', 'local', undefined)
    expect(request.needsGrant).toBe(false)
    expect(request.granted).toBe(false)
    expect(request.capabilities).toEqual(request.requested)
  })
})

describe('boundaryViolation', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'flexagent-sandbox-ws-'))
  const dataDir = mkdtempSync(join(tmpdir(), 'flexagent-sandbox-data-'))
  const workspaceProgram = join(workspace, 'hook.mjs')
  const dataProgram = join(dataDir, 'hook.mjs')
  writeFileSync(workspaceProgram, '// hook\n')
  writeFileSync(dataProgram, '// hook\n')
  const workspaceCaps: PluginCapabilities = { fs: 'workspace', env: 'minimal', network: false }

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('a hook granted the workspace may run a program from it', () => {
    expect(
      boundaryViolation({
        type: 'process',
        command: workspaceProgram,
        cwd: workspace,
        workspaceCwd: workspace,
        capabilities: workspaceCaps
      })
    ).toBeNull()
  })

  it('a plugin-data hook reaching into the workspace is refused before it starts', () => {
    const message = boundaryViolation({
      type: 'process',
      command: process.execPath,
      args: [workspaceProgram],
      cwd: dataDir,
      workspaceCwd: workspace,
      capabilities: LEAST_PRIVILEGE
    })
    expect(message).toContain('inside the workspace')
    expect(message).toContain('plugin-data')
  })

  it('the interpreter is a system program, not a crossing — only the script is judged', () => {
    expect(
      boundaryViolation({
        type: 'process',
        command: process.execPath,
        args: [dataProgram],
        cwd: dataDir,
        workspaceCwd: workspace,
        capabilities: LEAST_PRIVILEGE
      })
    ).toBeNull()
  })

  it('a bare executable name is left to the child PATH, not judged here', () => {
    expect(
      boundaryViolation({
        type: 'process',
        command: 'node',
        cwd: workspace,
        workspaceCwd: workspace,
        capabilities: LEAST_PRIVILEGE
      })
    ).toBeNull()
  })

  it('shell commands are not judged — there is no single program to check', () => {
    expect(
      boundaryViolation({
        type: 'command',
        command: `node ${workspaceProgram}`,
        cwd: workspace,
        workspaceCwd: workspace,
        capabilities: LEAST_PRIVILEGE
      })
    ).toBeNull()
  })

  it('a path that does not exist is not a violation, it is a spawn error', () => {
    expect(
      boundaryViolation({
        type: 'process',
        command: join(workspace, 'nope', 'missing.mjs'),
        cwd: workspace,
        workspaceCwd: workspace,
        capabilities: LEAST_PRIVILEGE
      })
    ).toBeNull()
  })
})

describe('hooks file capabilities', () => {
  it('reads a declaration next to the hooks', () => {
    const parsed = extractHookEntries(
      {
        capabilities: { fs: 'workspace', env: 'inherit' },
        hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] }
      },
      join(PLUGIN_ROOT, 'hooks', 'hooks.json')
    )
    expect(parsed.capabilities).toEqual({ fs: 'workspace', env: 'inherit' })
    expect(parsed.entries).toHaveLength(1)
  })

  it('drops values it cannot read instead of guessing', () => {
    const parsed = extractHookEntries(
      { capabilities: { fs: 'everywhere', env: 'whatever', network: 'yes' }, hooks: {} },
      join(PLUGIN_ROOT, 'hooks', 'hooks.json')
    )
    expect(parsed.capabilities).toBeUndefined()
  })

  it('a file that declares nothing keeps the baseline', () => {
    const parsed = extractHookEntries(
      { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } },
      join(PLUGIN_ROOT, 'hooks', 'hooks.json')
    )
    expect(parsed.capabilities).toBeUndefined()
  })

  it('reads a declaration even when the hooks block is unusable', () => {
    const parsed = extractHookEntries(
      { capabilities: { network: true } },
      join(PLUGIN_ROOT, 'hooks', 'hooks.json')
    )
    expect(parsed.capabilities).toEqual({ network: true })
    expect(parsed.diagnostics[0]?.code).toBe('plugin_hook_invalid')
  })
})

describe('runHook under a capability set', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'flexagent-sandbox-run-ws-'))
  const dataDir = mkdtempSync(join(tmpdir(), 'flexagent-sandbox-run-data-'))
  const probe = join(dataDir, 'probe.mjs')
  writeFileSync(
    probe,
    [
      "const secret = process.env.FLEXAGENT_TEST_SECRET ?? null",
      "const path = process.env.PATH ?? null",
      "process.stdout.write(JSON.stringify({ secret, hasPath: path !== null, cwd: process.cwd() }))"
    ].join('\n')
  )

  afterAll(() => {
    delete process.env.FLEXAGENT_TEST_SECRET
    rmSync(workspace, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('the child sees no credentials and starts in the data directory', async () => {
    process.env.FLEXAGENT_TEST_SECRET = 'sk-should-not-leak'
    const result = await runHook({
      type: 'process',
      command: process.execPath,
      args: [probe],
      cwd: workspace,
      plugin: { rootPath: PLUGIN_ROOT, dataPath: dataDir, id: 'demo@marketplace', name: 'demo' },
      capabilities: LEAST_PRIVILEGE,
      timeoutMs: 20_000
    })
    expect(result.status).toBe('ok')
    const output = JSON.parse(result.stdout) as {
      secret: string | null
      hasPath: boolean
      cwd: string
    }
    expect(output.secret).toBeNull()
    expect(output.hasPath).toBe(true)
    expect(output.cwd).toBe(dataDir)
  })

  it('a hook that asks for more than it was granted never starts', async () => {
    const result = await runHook({
      type: 'process',
      command: process.execPath,
      args: [probe],
      cwd: workspace,
      capabilities: LEAST_PRIVILEGE,
      declared: { network: true },
      timeoutMs: 20_000
    })
    expect(result.status).toBe('sandbox_denied')
    expect(result.diagnostics[0]?.code).toBe('sandbox_denied')
    expect(result.stdout).toBe('')
  })
})

describe('sandbox roots are real paths', () => {
  it('normalizes separators so a trailing slash does not leak', () => {
    const roots = sandboxRoots({
      capabilities: { fs: 'workspace', env: 'minimal', network: false },
      workspaceCwd: `${WORKSPACE}${sep}`
    })
    expect(roots[0]).toBe(WORKSPACE)
  })
})
