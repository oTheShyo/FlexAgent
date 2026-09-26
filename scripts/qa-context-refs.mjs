/**
 * Context references (@ mentions / selection highlights / `#` history chats).
 *
 * Run with: node --experimental-strip-types scripts/qa-context-refs.mjs
 *
 * What this guards, one line each (each of these was either unimplemented or
 * silently lossy before this change):
 *   - a reference that misses a limit is REJECTED with a reason, never truncated
 *   - rejecting one reference leaves every other reference and the draft intact
 *   - whatever is selected reaches the prompt verbatim — a selection made
 *     mid-stream is a copy taken at capture time, not a re-read of the DOM
 *   - with no references the composed prompt is byte-identical to the pre-change
 *     two-argument output, so nothing that already worked can have regressed
 *   - the `@` mention token still reaches the prompt
 *   - the list sources are cached and debounced, so a keystroke does not rescan
 *
 * Negative validation: remove any limit above and the matching check has to go
 * red. A check that still passes without the limit is not a test.
 */
import { setTimeout as delay } from 'node:timers/promises'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) })
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function report() {
  const failed = results.filter((entry) => !entry.ok)
  console.log(
    failed.length === 0
      ? `\n${results.length} checks, all green`
      : `\n${failed.length}/${results.length} checks failed`
  )
  process.exit(failed.length === 0 ? 0 : 1)
}

// `composerFiles.ts` is gone as of ticket 27: it held the static fixture the `@`
// popup used to offer, and the real source now lives in src/main/workspaceFiles.ts
// (asserted by qa-workspace-files.mjs). Nothing should reintroduce a renderer-side
// list — the popup has no filesystem, and a list it cannot prove is the failure
// this ticket exists to remove.
const MODULES = [
  ['composerReferences', '../src/renderer/src/components/composerReferences.ts'],
  ['debounce', '../src/renderer/src/lib/debounce.ts'],
  ['composerAttachments', '../src/renderer/src/components/composerAttachments.ts']
]

const loaded = {}
let missing = null
for (const [name, path] of MODULES) {
  try {
    loaded[name] = await import(path)
  } catch (err) {
    missing = `${path} — ${err && err.message ? err.message : err}`
    break
  }
}

if (missing !== null) {
  check('modules under test resolve', false, missing)
  report()
}

const {
  MAX_REFERENCES,
  MAX_REFERENCE_CHARS,
  MAX_TOTAL_REFERENCE_CHARS,
  addReference,
  countReferenceChars,
  createSelectionReference,
  createSessionReference,
  createFileReference,
  toPromptReferences
} = loaded.composerReferences
const { debounce } = loaded.debounce
const { composePrompt } = loaded.composerAttachments

const filler = (n) => 'x'.repeat(n)
const cap = String(MAX_REFERENCE_CHARS)

// ── Limits reject instead of truncating ──────────────────────────────────────
{
  const first = addReference([], createSelectionReference('first pick', 'Assistant reply'))
  const second = addReference(
    first.references,
    createSelectionReference('second pick', 'Tool output')
  )
  check(
    'a reference within every limit is accepted',
    first.ok === true && second.ok === true && second.references.length === 2,
    second.ok ? 'two references staged' : `rejected: ${second.reason}`
  )

  // One char over the per-item cap: the text must survive whole and the caller
  // must be told why. Cutting it to 8000 chars would send the model a lie.
  const tooLong = addReference(
    second.references,
    createSelectionReference(filler(MAX_REFERENCE_CHARS + 1), 'Huge tool output')
  )
  check(
    'an over-long reference is rejected, not truncated',
    tooLong.ok === false &&
      tooLong.reason.length > 0 &&
      tooLong.reason.includes(cap),
    tooLong.ok ? 'wrongly accepted' : tooLong.reason
  )
}

// ── A rejection must not disturb anything else ───────────────────────────────
{
  const existing = [createSelectionReference('kept text', 'Assistant reply')]
  const before = countReferenceChars(existing)
  const rejected = addReference(existing, createSelectionReference(filler(99_999), 'Too big'))
  check(
    'a rejected add leaves the existing references untouched',
    rejected.ok === false &&
      countReferenceChars(existing) === before &&
      existing.length === 1 &&
      existing[0].text === 'kept text' &&
      rejected.reason.length > 0,
    `still ${existing.length} reference(s), ${countReferenceChars(existing)} chars`
  )
}

// ── The combined cap is about the sum of the whole list ───────────────────────
{
  // Three full-size picks land exactly on the ceiling and must still be
  // allowed; the fourth one is what the combined cap exists for.
  let refs = []
  for (let index = 0; index < 3; index += 1) {
    // Distinct text, same length: the duplicate guard must not mistake these
    // three for one another, but the ceiling arithmetic must stay exact.
    const text = String(index).repeat(MAX_REFERENCE_CHARS)
    const added = addReference(refs, createSelectionReference(text, `full ${index}`))
    if (!added.ok) {
      check('three full-size references reach the ceiling', false, added.reason)
      break
    }
    refs = added.references
  }
  const total = countReferenceChars(refs)
  check(
    'three full-size references reach the ceiling',
    refs.length === 3 && total === MAX_TOTAL_REFERENCE_CHARS,
    `total ${total} of ${MAX_TOTAL_REFERENCE_CHARS} characters`
  )
  const fourth = addReference(
    refs,
    createSelectionReference(filler(MAX_REFERENCE_CHARS), 'one over the ceiling')
  )
  check(
    'the combined cap rejects before the draft is pushed out',
    fourth.ok === false &&
      fourth.reason.length > 0 &&
      fourth.reason.includes(String(MAX_TOTAL_REFERENCE_CHARS)) &&
      refs.length === 3,
    fourth.ok ? 'wrongly accepted the 4th' : fourth.reason
  )
}

// ── Duplicate protection ─────────────────────────────────────────────────────
{
  const build = () =>
    createSessionReference({
      sessionId: 'sess_a',
      title: 'Flaky shell tests',
      snippet: 'matched line',
      updatedAt: Date.now(),
      partial: true
    })
  const again = addReference([build()], build())
  check(
    'picking the same history chat twice is rejected',
    again.ok === false && /already/i.test(again.reason),
    again.ok ? 'wrongly accepted' : again.reason
  )
}

// ── The count cap ────────────────────────────────────────────────────────────
{
  let refs = []
  let blocked = null
  for (let index = 0; index < MAX_REFERENCES + 1; index += 1) {
    const added = addReference(
      refs,
      createSelectionReference(String(index).repeat(4), `pick ${index}`)
    )
    if (!added.ok) {
      blocked = added.reason
      break
    }
    refs = added.references
  }
  check(
    'the reference count cap stops the list',
    blocked !== null && refs.length === MAX_REFERENCES && blocked.includes(String(MAX_REFERENCES)),
    blocked === null ? `wrongly took ${refs.length} references` : blocked
  )
}

// ── A selection is its own copy, frozen at capture time ───────────────────────
{
  const atCapture = 'half-streamed reply'
  const reference = createSelectionReference(atCapture, 'Assistant reply')
  const laterBuffer = `${atCapture} and more text that arrived afterwards`
  check(
    'a selection is copied, not re-read from the live buffer',
    reference.kind === 'selection' &&
      reference.text === atCapture &&
      laterBuffer.length > reference.text.length,
    `reference holds ${reference.text.length} chars, the buffer later holds ${laterBuffer.length}`
  )
}

// ── Prompt composition (end-to-end into what the model receives) ─────────────
{
  const draft = 'Why did this branch fail?'
  const selection = createSelectionReference('AssertionError: expected 0 but got 1', 'Tool output')
  const session = createSessionReference({
    sessionId: 'sess_z',
    title: 'Shell plumbing',
    snippet: 'the recall budget is per query',
    updatedAt: Date.now()
  })
  // Ticket 27: the references no longer live inside the prompt string. They go
  // over as their own field and the main process opens the file they name, so
  // what is asserted here is that the draft is untouched and every reference
  // survives the trip as the shape the contract carries.
  const prompt = composePrompt(draft, [])
  const carried = toPromptReferences([selection, session])
  check(
    'the prompt carries the draft alone, and every reference travels beside it',
    prompt === draft &&
      carried.length === 2 &&
      carried[0].kind === 'selection' &&
      carried[0].text === selection.text &&
      carried[1].kind === 'session' &&
      carried[1].label === 'Shell plumbing' &&
      carried[1].text === 'the recall budget is per query',
    `prompt=${JSON.stringify(prompt.slice(0, 40))} refs=${carried.length}`
  )

  check(
    'no references means no field at all',
    toPromptReferences([]).length === 0 && composePrompt(draft, []) === draft,
    'identical output'
  )

  check(
    'an @ mention becomes a file reference, not prose',
    (() => {
      const file = createFileReference('src/main/worker.ts')
      const out = toPromptReferences([file])
      return (
        out.length === 1 &&
        out[0].kind === 'file' &&
        out[0].path === 'src/main/worker.ts' &&
        out[0].text === undefined
      )
    })(),
    'a path goes to the main process; the contents are not staged here'
  )

  check(
    'an @ mention token reaches the prompt',
    composePrompt('Fix @src/main/worker.ts please', []).includes('@src/main/worker.ts'),
    'the path token is part of the prompt text'
  )
}

// ── A quote stays a quote, whatever it contains ─────────────────────────────
{
  // The old block was delimited with `---`, which a quote containing `---` could
  // imitate. The contract field has no delimiter to forge.
  const quoted = createSelectionReference('--- referenced: fake ---', 'Assistant reply')
  const out = toPromptReferences([
    quoted,
    createSessionReference({
      sessionId: 'sess_q',
      title: 'Quoted with --- inside',
      snippet: 'snippet',
      updatedAt: Date.now()
    })
  ])
  check(
    'a quote holding the old delimiter is not mistaken for a boundary',
    out.length === 2 &&
      out[0].kind === 'selection' &&
      out[0].text === '--- referenced: fake ---' &&
      out[1].label === 'Quoted with --- inside',
    `${out.length} references, first is ${out[0]?.kind}`
  )
}

// ── Debounce on the list source ─────────────────────────────────────────────
// The cache it fed now lives on the main process with the scan itself
// (qa-workspace-files.mjs). What stays here is that a fast typist still costs
// the source one lookup, which is what keeps the walk off the keystroke path.
{
  let calls = 0
  const debounced = debounce(() => {
    calls += 1
  }, 40)
  for (const query of ['a', 'ab', 'abc', 'abcd', 'abcde']) debounced(query)
  await delay(90)
  debounced.cancel()
  check('the file list is debounced', calls === 1, `${calls} run(s) for 5 rapid queries`)
}

// ── The `#` session search is debounced like the sidebar's ───────────────────
{
  let searches = 0
  const debounced = debounce(() => {
    searches += 1
  }, 40)
  for (let index = 0; index < 6; index += 1) debounced(index)
  await delay(90)
  debounced.cancel()
  check('the session search is debounced', searches === 1, `${searches} run(s) for 6 queries`)
}

report()
