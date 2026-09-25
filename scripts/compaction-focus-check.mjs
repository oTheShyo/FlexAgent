// Fails if the compaction summary focus is back to being always undefined.
//
// `compact()` was being handed `event.customInstructions` directly, and nothing
// in the repo ever set it. The summary still got written, so nothing complained
// — the focus only ever affected wording and what survives.
//
// Run with: node --experimental-strip-types scripts/compaction-focus-check.mjs
import { compactionFocus } from '../src/main/compactionRouting.ts'

let failed = 0

function check(label, ok, detail = '') {
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

const plain = compactionFocus({ signal: new AbortController().signal })
check('no instruction from the caller still yields a focus', plain.length > 0, `${plain.length} chars`)
check('the focus forbids tools and drafts', plain.includes('Summarise only') && !plain.includes('Call the'))
check('the focus says what to keep', plain.includes('Preserve:') && plain.includes('Drop:'))
check('the focus keeps the output promise even without a caller', plain.includes('one block of plain prose'))

// The whole point of joining, rather than replacing, is that an explicit
// instruction cannot quietly drop the format promise the summary depends on.
const asked = compactionFocus({
  signal: new AbortController().signal,
  customInstructions: 'keep the failing test names'
})
check('an explicit instruction is carried through', asked.includes('keep the failing test names'))
check('an explicit instruction does not replace the focus', asked.includes('Summarise only') && asked.includes('Preserve:'))

const empty = compactionFocus({ signal: new AbortController().signal, customInstructions: '' })
check('an empty string is treated like undefined', empty === plain, 'PI checks truthiness, not presence')

console.log(failed === 0 ? '\ncompaction focus is wired' : `\n${failed} problem(s)`)
process.exit(failed === 0 ? 0 : 1)
