/**
 * Assertions for the scope-aware rule layer (issue #19).
 *
 * Imported by the regression suite (live sources) and by the negative check
 * (HEAD sources, see `.scratch/perm-scope-negcheck.mjs`), so every assertion in
 * here is run twice: once against the current implementation and once against
 * the one it replaced. A new assertion that would also pass on the old code is
 * not testing that the bug is fixed — `oldBehaviour` records which side of that
 * split each case is on.
 *
 *   run(mods, ctx) -> Promise<{ ok: boolean, detail: string }>
 *   oldBehaviour: 'fails' | 'same'
 *     'fails' — the old implementation answers this differently (or cannot
 *               express it at all), so it must FAIL there.
 *     'same'  — the guarantee predates #19; listed so the ordering change is
 *               proven not to have disturbed it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
function expect(mods, ctx) {
  return async (name, request, options, want, detail) => {
    try {
      const gate = new mods.gate.PermissionGate()
      const { outcome, verdict } = await gate.evaluate(request, {
        mode: 'default',
        cwd: options.cwd ?? ctx.cwd,
        rules: options.rules ?? [],
        memory: new mods.gate.PermissionMemory(`perm-regress:${name}`),
        sessionId: `perm-regress:${name}`,
        ...(options.classifyBash === undefined ? {} : { classifyBash: options.classifyBash })
      })
      // `not-rule-allow` is the guarantee a scope has to give: elsewhere in the
      // project the call may still be allowed, but not *by this rule* — a
      // heuristic allowing it is a different layer doing its job.
      const wantOk =
        want === 'not-allow'
          ? outcome !== 'allow'
          : want === 'not-rule-allow'
            ? !(outcome === 'allow' && verdict.via === 'rule')
            : want === 'credential'
              // Outcome alone is not enough: "deny" must come from the boundary,
              // not from some other layer that happens to refuse this call.
              ? verdict.reason.includes('credential')
              : want === 'any'
                ? true
                : outcome === want
      return { ok: wantOk, detail: `${outcome} (want ${want}) via ${verdict.via}: ${verdict.reason}` }
    } catch (err) {
      return { ok: false, detail: `threw: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
}

/** The deny/ask/allow ordering, and the two boundaries it must not cross. */
export const RULE_CASES = [
  {
    name: 'deny rule beats an earlier allow rule',
    oldBehaviour: 'fails',
    run: async (mods, ctx, evaluate) =>
      evaluate(
        'deny-priority',
        { toolName: 'bash', args: { command: 'pnpm run build' } },
        {
          rules: [
            { id: 'permissive', tool: 'bash', action: 'allow', note: 'written first' },
            { id: 'picky', tool: 'bash', command: 'pnpm run build', action: 'deny', note: 'written second' }
          ]
        },
        'deny'
      )
  },
  {
    name: 'ask rule beats an earlier allow rule',
    oldBehaviour: 'fails',
    run: async (mods, ctx, evaluate) =>
      evaluate(
        'ask-priority',
        { toolName: 'bash', args: { command: 'make all' } },
        {
          rules: [
            { id: 'permissive', tool: 'bash', action: 'allow', note: 'tool-wide allow' },
            { id: 'picky', tool: 'bash', command: 'make', action: 'ask', note: 'user wants to see this' }
          ]
        },
        'ask'
      )
  },
  {
    name: 'a user deny is not shadowed by a built-in allow',
    oldBehaviour: 'fails',
    run: async (mods, ctx, evaluate) =>
      evaluate(
        'user-deny-vs-builtin',
        { toolName: 'read_file', args: { path: `${ctx.cwd}/src/tokens.ts` } },
        {
          // `read-tools` (built-in, allow) matches by the same substring the user
          // rule matches, and sits earlier in the list. First-hit-wins let it win.
          rules: [
            { id: 'read-tools', tool: '*read*', action: 'allow', note: 'Read-only tool' },
            { id: 'no-read-file', tool: 'read_file', action: 'deny', note: 'user: this file stays closed' }
          ]
        },
        'deny'
      )
  },
  {
    name: 'hard-denied pattern is not rule-overridable',
    oldBehaviour: 'fails',
    run: async (mods, ctx, evaluate) =>
      evaluate(
        'hard-deny-override',
        { toolName: 'bash', args: { command: 'rm -rf /Users/hp/work' } },
        { rules: [{ id: 'trust-me', tool: 'bash', command: 'rm -rf', action: 'allow', note: 'user allow' }] },
        'deny'
      )
  },
  {
    name: 'hard-denied dd-to-block-device is not rule-overridable',
    oldBehaviour: 'fails',
    run: async (mods, ctx, evaluate) =>
      evaluate(
        'hard-deny-dd',
        { toolName: 'bash', args: { command: 'dd if=/dev/zero of=/dev/sda' } },
        { rules: [{ id: 'trust-me', tool: 'bash', action: 'allow', note: 'user allow' }] },
        'deny'
      )
  },
  {
    name: 'credential write is not rule-overridable',
    // The credential layer already sat above the rules before #19 — what #19
    // adds is the proof, and the reason check that keeps the proof honest.
    oldBehaviour: 'same',
    run: async (mods, ctx, evaluate) =>
      evaluate(
        'credential-write',
        { toolName: 'write', args: { path: `${ctx.cwd}/.ssh/id_rsa` } },
        { rules: [{ id: 'trust-me', tool: '*', action: 'allow', note: 'user allow' }] },
        'credential'
      )
  },
  {
    name: 'credential read is not rule-overridable',
    oldBehaviour: 'same',
    run: async (mods, ctx, evaluate) =>
      evaluate(
        'credential-read',
        { toolName: 'read', args: { path: `${ctx.cwd}/.aws/credentials` } },
        { rules: [{ id: 'trust-me', tool: 'read', action: 'allow', note: 'user allow' }] },
        'credential'
      )
  },
  {
    name: 'a project rule does not reach another project',
    oldBehaviour: 'fails',
    run: async (mods, ctx, evaluate) =>
      evaluate(
        'scope-other-project',
        { toolName: 'bash', args: { command: 'npm test' } },
        {
          rules: [
            {
              id: 'project-test',
              tool: 'bash',
              command: 'npm test',
              action: 'allow',
              scope: 'project',
              projectPath: ctx.cwd,
              note: 'allow in this project'
            }
          ],
          cwd: ctx.otherCwd
        },
        'not-rule-allow'
      )
  },
  {
    name: 'a project rule fires inside its own project',
    // Positive control: an unscoped rule also fires here, so this must keep
    // passing. The guarantee is proved from the other direction.
    oldBehaviour: 'same',
    run: async (mods, ctx, evaluate) =>
      evaluate(
        'scope-own-project',
        { toolName: 'bash', args: { command: 'npm test' } },
        {
          rules: [
            {
              id: 'project-test',
              tool: 'bash',
              command: 'npm test',
              action: 'allow',
              scope: 'project',
              projectPath: ctx.cwd,
              note: 'allow in this project'
            }
          ],
          cwd: ctx.cwd
        },
        'allow'
      )
  },
  {
    // The scope a rule gets when the user picks the widest option; it behaves
    // like a pre-#19 rule, which is the point.
    name: 'a global rule crosses projects',
    oldBehaviour: 'same',
    run: async (mods, ctx, evaluate) =>
      evaluate(
        'scope-global',
        { toolName: 'bash', args: { command: 'npm test' } },
        {
          rules: [{ id: 'any-test', tool: 'bash', command: 'npm test', action: 'allow', note: 'allow anywhere' }],
          cwd: ctx.otherCwd
        },
        'allow'
      )
  },
  {
    // Acceptance item 3: a rule hit must not fall through to the classifier.
    name: 'a rule hit does not call the classifier',
    oldBehaviour: 'same',
    run: async (mods, ctx) => {
      let calls = 0
      const gate = new mods.gate.PermissionGate()
      const { outcome } = await gate.evaluate(
        { toolName: 'bash', args: { command: 'python -m http.server 8080' } },
        {
          mode: 'default',
          cwd: ctx.cwd,
          rules: [{ id: 'python', tool: 'bash', command: 'python', action: 'allow', note: 'allow python' }],
          memory: new mods.gate.PermissionMemory('perm-regress:no-classifier'),
          sessionId: 'perm-regress:no-classifier',
          classifyBash: async () => {
            calls += 1
            return { outcome: 'allow', via: 'classifier', reason: 'asked a model' }
          }
        }
      )
      return {
        ok: outcome === 'allow' && calls === 0,
        detail: `outcome=${outcome}, classifier calls=${calls}`
      }
    }
  },
  {
    name: 'rules loaded from disk take effect after a restart',
    oldBehaviour: 'fails',
    run: async (mods, ctx) => {
      const rulesMod = mods.rules
      if (typeof rulesMod?.addUserRule !== 'function') {
        return { ok: false, detail: 'addUserRule is not exported by the rule module' }
      }
      await rulesMod.addUserRule({
        tool: 'bash',
        args: { command: 'npm test' },
        sessionId: 'perm-regress',
        cwd: ctx.cwd,
        scope: 'project',
        action: 'allow',
        note: 'saved from the dialog'
      })
      const saved = rulesMod.loadRuleSet().rules
      const rule = saved[saved.length - 1]
      // A brand-new gate, and a rule set read back from the file: nothing in
      // this process remembers the decision.
      const gate = new mods.gate.PermissionGate()
      const { outcome } = await gate.evaluate(
        { toolName: 'bash', args: { command: 'npm test' } },
        {
          mode: 'default',
          cwd: ctx.cwd,
          rules: rulesMod.effectiveRuleSet().rules,
          memory: new mods.gate.PermissionMemory('perm-regress:reload'),
          sessionId: 'perm-regress:reload'
        }
      )
      return {
        ok: outcome === 'allow' && rule?.action === 'allow',
        detail: `outcome=${outcome}, saved ${JSON.stringify(rule)}`
      }
    }
  },
  {
    name: 'a saved rule carries an id, a timestamp and an origin',
    oldBehaviour: 'fails',
    run: async (mods, ctx) => {
      const rulesMod = mods.rules
      if (typeof rulesMod?.addUserRule !== 'function') {
        return { ok: false, detail: 'addUserRule is not exported by the rule module' }
      }
      const set = await rulesMod.addUserRule({
        tool: 'bash',
        args: { command: 'npm run lint' },
        sessionId: 'perm-regress',
        cwd: ctx.cwd,
        scope: 'global',
        action: 'allow',
        note: 'saved from the dialog'
      })
      const rule = set.rules[set.rules.length - 1]
      const ok =
        typeof rule?.id === 'string' &&
        rule.id.length > 0 &&
        typeof rule.createdAt === 'number' &&
        rule.createdAt > 0 &&
        rule.origin === 'user' &&
        rule.scope === 'global'
      return { ok, detail: JSON.stringify(rule) }
    }
  },
  {
    // The other half of persistence: a revoked rule must stop deciding.
    name: 'revoking a rule restores the earlier verdict',
    oldBehaviour: 'fails',
    run: async (mods, ctx) => {
      const rulesMod = mods.rules
      if (typeof rulesMod?.addUserRule !== 'function' || typeof rulesMod?.removeUserRule !== 'function') {
        return { ok: false, detail: 'the rule module cannot add or remove rules' }
      }
      const set = await rulesMod.addUserRule({
        tool: 'bash',
        args: { command: 'npm run build' },
        sessionId: 'perm-regress',
        cwd: ctx.cwd,
        scope: 'global',
        action: 'allow',
        note: 'saved from the dialog'
      })
      const id = set.rules[set.rules.length - 1]?.id
      await rulesMod.removeUserRule(id ?? '')
      const gate = new mods.gate.PermissionGate()
      const { outcome } = await gate.evaluate(
        { toolName: 'bash', args: { command: 'npm run build' } },
        {
          mode: 'default',
          cwd: ctx.cwd,
          rules: rulesMod.effectiveRuleSet().rules,
          memory: new mods.gate.PermissionMemory('perm-regress:revoke'),
          sessionId: 'perm-regress:revoke'
        }
      )
      return {
        ok: outcome !== 'allow',
        detail: `after revoke: ${outcome} (want not-allow — the rule is gone)`
      }
    }
  },
  {
    name: 'a saved allow does not widen to the whole tool',
    oldBehaviour: 'fails',
    run: async (mods, ctx) => {
      const rulesMod = mods.rules
      if (typeof rulesMod?.addUserRule !== 'function') {
        return { ok: false, detail: 'addUserRule is not exported by the rule module' }
      }
      await rulesMod.addUserRule({
        tool: 'bash',
        args: { command: 'npm test' },
        sessionId: 'perm-regress',
        cwd: ctx.cwd,
        scope: 'global',
        action: 'allow',
        note: 'saved from the dialog'
      })
      const gate = new mods.gate.PermissionGate()
      const { outcome } = await gate.evaluate(
        { toolName: 'bash', args: { command: 'rm -rf node_modules' } },
        {
          mode: 'default',
          cwd: ctx.cwd,
          rules: rulesMod.effectiveRuleSet().rules,
          memory: new mods.gate.PermissionMemory('perm-regress:narrow'),
          sessionId: 'perm-regress:narrow'
        }
      )
      return {
        ok: outcome === 'deny',
        detail: `rm -rf under an "allow npm test" rule: ${outcome} (want deny)`
      }
    }
  }
]

/**
 * Source-level guards for the shape these changes depend on.
 *
 * The behavioural cases above would still pass if someone inlined the rule
 * collection back into `evaluate`, or folded the hard-deny list back into
 * `classifyBashCommand`. These anchored (line-start, no leading whitespace)
 * patterns fail loudly in that case — a loose `includes('deny')` would not.
 */
export const SOURCE_ASSERTIONS = [
  {
    file: 'src/main/permissionGate.ts',
    pattern: /^export function hardDenyFor\(command: string\): string \| undefined \{$/m,
    why: 'the hard-deny check is its own layer above the rules'
  },
  {
    file: 'src/main/permissionGate.ts',
    pattern: /^const RULE_ORDER: readonly PermissionRuleAction\[\] = \['deny', 'ask', 'allow'\]$/m,
    why: 'refusals are collected before questions, questions before allowances'
  },
  {
    file: 'src/main/permissionGate.ts',
    pattern: /^function ruleMatchesScope\(rule: PermissionRule, cwd: string\): boolean \{$/m,
    why: 'the ownership dimension is matched per rule, not per call'
  },
  {
    file: 'src/main/permissionRules.ts',
    pattern: /^export async function addUserRule\(input: PersistedRuleInput\): Promise<PermissionRuleSet> \{$/m,
    why: 'rules can be authored from a call'
  },
  {
    file: 'src/main/permissionRules.ts',
    pattern: /^export async function removeUserRule\(id: string\): Promise<PermissionRuleSet> \{$/m,
    why: 'a saved rule can be taken back'
  },
  {
    file: 'src/main/permissionRules.ts',
    pattern: /^function writeRuleFile\(rules: readonly PermissionRule\[\]\): PermissionRuleSet \{$/m,
    why: 'writes go through one staging-and-rename path'
  }
]

export function runSourceAssertions(root, log) {
  let failed = 0
  for (const assertion of SOURCE_ASSERTIONS) {
    // CRLF: the sources are checked out with Windows line endings, and `$`
    // would otherwise stop matching just short of every line end.
    const raw = readFileSync(join(root, assertion.file), 'utf8').replace(/\r\n/gu, '\n')
    const ok = assertion.pattern.test(raw)
    if (!ok) failed += 1
    log(`${ok ? 'PASS' : 'FAIL'}  ${(assertion.file + ' · ' + assertion.why).padEnd(46)} ${ok ? '' : `missing ${assertion.pattern}`}`)
  }
  return failed
}

export async function runRuleAssertions(mods, ctx, log) {
  const evaluate = expect(mods, ctx)
  let failed = 0
  for (const testCase of RULE_CASES) {
    let result
    try {
      result = await testCase.run(mods, ctx, evaluate)
    } catch (err) {
      result = { ok: false, detail: `threw: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (!result.ok) failed += 1
    log(`${result.ok ? 'PASS' : 'FAIL'}  ${testCase.name.padEnd(46)} ${result.detail}`)
  }
  return failed
}
