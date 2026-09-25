// Fails if a role persona has lost the shared output contract.
//
// The contract was defined once and never referenced for several rounds, which
// means nothing in the repo would have noticed a persona that skipped it. This
// is the cheap part of the fix: an audit that can fail, not a comment that can
// be ignored.
//
// Run with: node --experimental-strip-types scripts/role-contract-check.mjs
import { auditPersonaContracts, auditSymmetry, ROLES } from '../src/main/agents/roles.ts'

let failed = 0

function check(label, ok, detail = '') {
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

const roles = Object.values(ROLES)

check('persona audit lists every role', roles.length > 0, `${roles.length} roles`)
check('every persona carries the output contract', auditPersonaContracts().length === 0, auditPersonaContracts().join('; '))
check('parallel symmetry still holds', auditSymmetry().length === 0, auditSymmetry().join('; '))

// The contract is what the parent parses, so it has to be at the tail of the
// persona rather than somewhere in the middle of the prose.
for (const role of roles) {
  const tail = role.persona.slice(-400)
  check(`${role.name}: contract lands at the end of the persona`, tail.includes('Stay inside your role'), 'a persona without a tail reads fine and behaves badly')
}

console.log(failed === 0 ? `\n${roles.length} roles, contracts in place` : `\n${failed} problem(s)`)
process.exit(failed === 0 ? 0 : 1)
