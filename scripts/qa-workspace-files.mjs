/**
 * Ticket 27: the file list behind `@`, and the block built from it.
 *
 * Everything here runs against a real temporary tree, because the thing being
 * replaced was a hardcoded list of paths — an assertion that only checked the
 * filtering of a static array would have passed on the old code and proven
 * nothing.
 *
 * The cases that matter are the ones where opening a file must *fail*: a path
 * that escapes the root, a directory, a binary. Each has to come back as a
 * stated refusal, because a mention that silently contributes nothing is
 * indistinguishable from one that worked.
 *
 * Run with: node --experimental-strip-types scripts/qa-workspace-files.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { build } from 'esbuild'

const ROOT = process.cwd()
const OUT = join(ROOT, 'out', 'qa', 'workspace-files')

// The modules import each other without extensions, which node's ESM loader will
// not resolve, so they are bundled the way the other qa-* scripts do it.
async function bundle() {
  await build({
    entryPoints: [
      join(ROOT, 'src/main/workspaceFiles.ts'),
      join(ROOT, 'src/main/promptReferences.ts')
    ],
    outdir: OUT,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'error',
    outExtension: { '.js': '.mjs' }
  })
}

const load = (name) => import(`${pathToFileURL(join(OUT, `${name}.mjs`)).href}?t=${Date.now()}`)
const results = []
const failed = []

function check(name, ok, detail = '') {
  results.push(name)
  if (!ok) failed.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

function tree() {
  const root = mkdtempSync(join(tmpdir(), 'flex-files-'))
  mkdirSync(join(root, 'src', 'nested', 'deep'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, 'src', 'worker.ts'), 'export const worker = 1\n')
  writeFileSync(join(root, 'src', 'nested', 'deep', 'leaf.ts'), 'export const leaf = 2\n')
  writeFileSync(join(root, 'src', 'other.md'), '# other\n')
  writeFileSync(join(root, 'README.md'), 'readme\n')
  // These two exist precisely to be skipped: walking them is the difference
  // between a popup and a hang.
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
  writeFileSync(join(root, '.git', 'config'), '[core]\n')
  // A binary file, to be refused rather than inlined as replacement characters.
  writeFileSync(join(root, 'logo.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
  return root
}

async function main() {
  await bundle()
  const { listWorkspaceFiles, readWorkspaceFile, invalidateWorkspaceFiles, rankFiles } =
    await load('workspaceFiles')
  const { renderReferences, renderSessionTranscript } = await load('promptReferences')

  // ── The list is real, and skips what it must ──────────────────────────────
  {
    const root = tree()
    try {
      const all = await listWorkspaceFiles(root, '')
      check(
        'the list comes from the directory, not a fixture',
        all.includes('src/worker.ts') && all.includes('README.md'),
        all.slice(0, 3).join(', ')
      )
      check(
        'vendor and vcs directories are never walked',
        !all.some((p) => p.startsWith('node_modules/')) && !all.some((p) => p.startsWith('.git/')),
        'no node_modules, no .git'
      )
      check(
        'nested files are still found',
        all.includes('src/nested/deep/leaf.ts'),
        'depth is bounded, not depth 1'
      )
      check('paths are posix and relative', all.every((p) => !p.includes('\\') && !p.startsWith('/')), all[0])

      const filtered = await listWorkspaceFiles(root, 'worker')
      check(
        'a query narrows the list',
        filtered.length > 0 && filtered.every((p) => p.toLowerCase().includes('worker')),
        filtered.join(', ')
      )

      // ── Cache: the second scan must not re-walk ───────────────────────────
      const before = await listWorkspaceFiles(root, '')
      writeFileSync(join(root, 'appeared-later.ts'), 'export const later = 1\n')
      const during = await listWorkspaceFiles(root, '')
      invalidateWorkspaceFiles(root)
      const after = await listWorkspaceFiles(root, '')
      check(
        'the walk is cached, and invalidation is what refreshes it',
        !before.includes('appeared-later.ts') &&
          !during.includes('appeared-later.ts') &&
          after.includes('appeared-later.ts'),
        'a new file shows up only after invalidation'
      )

      // ── Ranking ──────────────────────────────────────────────────────────
      const ranked = rankFiles(['z/worker.ts', 'worker.ts', 'src/worker.ts'], 'worker')
      check(
        'a prefix match outranks a substring match',
        ranked[0] === 'worker.ts' && ranked.includes('src/worker.ts'),
        ranked.join(', ')
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  // ── Opening a file: the four ways it can go ───────────────────────────────
  {
    const root = tree()
    try {
      const good = await readWorkspaceFile(root, 'src/worker.ts')
      check(
        'a readable file comes back with its contents',
        good.ok && good.content.includes('export const worker') && good.truncated === false,
        good.ok ? `${good.content.length} chars` : good.reason
      )

      const escape = await readWorkspaceFile(root, '../../etc/passwd')
      check(
        'a path that leaves the root is refused',
        !escape.ok && /outside/.test(escape.reason),
        escape.ok ? 'READ — this is the whole point of the check' : escape.reason
      )

      const absolute = await readWorkspaceFile(root, join(tmpdir(), 'outside-abs.ts'))
      if (readdirSync(tmpdir()).length >= 0) {
        check(
          'an absolute path outside the root is refused too',
          !absolute.ok && /outside/.test(absolute.reason),
          absolute.ok ? 'READ' : absolute.reason
        )
      }

      const dir = await readWorkspaceFile(root, 'src')
      check(
        'a directory is refused',
        !dir.ok && /directory/.test(dir.reason),
        dir.ok ? 'READ' : dir.reason
      )

      const binary = await readWorkspaceFile(root, 'logo.bin')
      check(
        'a binary file is refused rather than inlined',
        !binary.ok && /not a text file/.test(binary.reason),
        binary.ok ? 'INLINED' : binary.reason
      )

      const missing = await readWorkspaceFile(root, 'src/nope.ts')
      check('a missing file is refused with a reason', !missing.ok && missing.reason.length > 0, missing.reason)

      // ── Truncation is stated, not silent ─────────────────────────────────
      writeFileSync(join(root, 'big.ts'), 'x'.repeat(25_000))
      const big = await readWorkspaceFile(root, 'big.ts')
      check(
        'an oversized file is truncated and says so',
        big.ok && big.truncated === true && big.content.length < 25_000,
        big.ok ? `${big.content.length} chars, truncated=${big.truncated}` : big.reason
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  // ── The block the model actually sees ─────────────────────────────────────
  {
    const root = tree()
    try {
      const inline = await renderReferences(root, [
        { kind: 'file', label: 'src/worker.ts', path: 'src/worker.ts' }
      ])
      check(
        'a file mention arrives as contents, not a path',
        inline.block.includes('export const worker') && inline.block.includes('src/worker.ts'),
        'the model can read the file'
      )
      check('a readable file produces no notice', inline.notices.length === 0, inline.notices.join('; '))

      const broken = await renderReferences(root, [
        { kind: 'file', label: 'logo.bin', path: 'logo.bin' }
      ])
      check(
        'an unreadable file is stated in the block, not dropped',
        broken.block.includes('unreadable') && broken.notices.length === 1,
        broken.notices[0] ?? 'no notice'
      )

      const escaping = await renderReferences(root, [
        { kind: 'file', label: '../../etc/passwd', path: '../../etc/passwd' }
      ])
      check(
        'a mention cannot be used to read outside the project',
        !escaping.block.includes('root:') && escaping.notices.length === 1,
        escaping.notices[0] ?? 'no notice'
      )

      const quote = await renderReferences(root, [
        { kind: 'selection', label: 'Assistant reply', text: 'AssertionError: expected 0' }
      ])
      check(
        'a quote is carried verbatim',
        quote.block.includes('AssertionError: expected 0') && quote.block.includes('Assistant reply'),
        'selection text survives'
      )

      const empty = await renderReferences(root, [])
      check('no references means no block', empty.block === '' && empty.notices.length === 0, 'untouched prompt')

      const blank = await renderReferences(root, [{ kind: 'selection', label: 'x', text: '   ' }])
      check(
        'an empty reference is left out and named',
        blank.block === '' && blank.notices.length === 1,
        blank.notices[0] ?? 'no notice'
      )

      // ── The total budget omits rather than trims ─────────────────────────
      writeFileSync(join(root, 'big.ts'), 'y'.repeat(25_000))
      const overBudget = await renderReferences(root, [
        { kind: 'file', label: 'big.ts', path: 'big.ts' },
        { kind: 'file', label: 'big.ts (again)', path: 'big.ts' },
        { kind: 'file', label: 'big.ts (third)', path: 'big.ts' },
        { kind: 'file', label: 'big.ts (fourth)', path: 'big.ts' }
      ])
      const leftover = overBudget.notices.filter((n) => /over its limit/.test(n))
      check(
        'going over the budget omits the overflow and says which',
        leftover.length > 0 && overBudget.block.length > 0,
        `${leftover.length} of 4 omitted; block is ${overBudget.block.length} chars`
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  // ── A `#` citation: the transcript, bounded at a message boundary ─────────
  {
    const messages = [
      { role: 'user', content: 'why is the wall detection jittering?' },
      { role: 'assistant', content: 'because the 11px sub-image re-centres every frame' },
      // Empty content is common (a tool round-trip with no prose) and would put
      // a bare "Assistant:" line in the citation.
      { role: 'assistant', content: '   ' },
      { role: 'user', content: 'x'.repeat(7_000) }
    ]
    const full = renderSessionTranscript(messages)
    check(
      'a citation carries what the chat said, oldest first',
      full.text.startsWith('User: why is the wall detection') &&
        full.text.includes('11px sub-image') &&
        full.truncated === true,
      `truncated=${full.truncated}`
    )
    check(
      'a message with no prose leaves no empty line behind',
      !/\nAssistant:\s*$/m.test(full.text) && !full.text.includes('Assistant: \n'),
      'blank turns are skipped'
    )

    const tight = renderSessionTranscript(messages, 60)
    check(
      'the cap stops at a whole message, never mid-sentence',
      tight.truncated === true &&
        tight.text === 'User: why is the wall detection jittering?' &&
        !tight.text.includes('because'),
      JSON.stringify(tight.text.slice(0, 50))
    )

    check(
      'an empty transcript is empty, not a failed read',
      renderSessionTranscript([]).text === '' && renderSessionTranscript([]).truncated === false,
      'no messages, no text'
    )
  }

  console.log(
    failed.length === 0
      ? `\n${results.length} checks, all green`
      : `\n${failed.length}/${results.length} checks FAILED`
  )
  process.exit(failed.length === 0 ? 0 : 1)
}

await main()
