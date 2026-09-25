/**
 * Credential-path boundary (security §工具过滤 / 能力层限制).
 *
 * The permission gate already contains writes to the workspace and asks about
 * writes outside it — but "outside the workspace" and "a credential store" are
 * different questions. `~/.ssh/id_rsa` is outside the workspace (⇒ ask), while
 * `.env` sitting in the project root is *inside* it (⇒ currently allow) and
 * `cat ~/.ssh/id_rsa` reaches the read-only prefix allowlist before any path is
 * even considered (⇒ currently allow). Both are leaks with a single click or
 * none at all.
 *
 * Following the article's stance — restrict capability, do not try to judge
 * intent — this module answers one mechanical question: does this target name a
 * place where credentials live? The gate then treats it as:
 *
 * - write  → deny (irreversible from the agent's side; no mode lifts it)
 * - read   → ask  (legitimate work exists — the user may deliberately share a
 *                  project `.env` — so the human decides, once per session)
 */

export type SensitiveKind =
  | 'ssh-directory'
  | 'private-key'
  | 'cloud-credentials'
  | 'package-registry-token'
  | 'git-credentials'
  | 'env-file'
  | 'secret-store'

export interface SensitiveTarget {
  kind: SensitiveKind
  /** The path as it was written by the caller, for the prompt/verdict reason. */
  target: string
}

interface Matcher {
  kind: SensitiveKind
  test: (normalized: string, base: string) => boolean
}

/** Path separators are normalised to `/` and compared case-insensitively. */
const MATCHERS: Matcher[] = [
  { kind: 'ssh-directory', test: (p) => p.includes('/.ssh/') || p.endsWith('/.ssh') },
  {
    kind: 'private-key',
    test: (_p, base) =>
      /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/u.test(base) ||
      base.endsWith('.pem') ||
      base.endsWith('.key') ||
      base.endsWith('.pfx') ||
      base.endsWith('.p12') ||
      base === 'keystore.jks'
  },
  {
    kind: 'cloud-credentials',
    test: (p) =>
      p.includes('/.aws/credentials') ||
      p.includes('/.aws/config') ||
      p.includes('/.kube/config') ||
      p.includes('/.config/gcloud/') ||
      p.includes('/.azure/') ||
      p.includes('/.docker/config.json')
  },
  {
    kind: 'package-registry-token',
    test: (_p, base) => base === '.npmrc' || base === '.pypirc' || base === '.yarnrc' || base === '.yarnrc.yml'
  },
  { kind: 'git-credentials', test: (_p, base) => base === '.git-credentials' || base === '.gitconfig.netrc' },
  {
    kind: 'env-file',
    // Templates are meant to be committed and read — treating `.env.example`
    // as a secret would train users to click through the prompt.
    test: (_p, base) =>
      (/^\.env(\..+)?$/u.test(base) && !/^\.env\.(example|sample|template|dist|defaults)$/u.test(base)) ||
      base === 'dotenv'
  },
  {
    kind: 'secret-store',
    test: (_p, base) =>
      base === 'auth.json' ||
      base === 'mcp.json' ||
      base === 'credentials.json' ||
      base === 'secrets.json' ||
      base === 'secrets.yaml' ||
      base === 'secrets.yml' ||
      base === 'id_rsa' ||
      base === 'service-account.json'
  }
]

/** Windows drive letters and `~` are not resolved — only the shape is judged. */
function normalize(raw: string): string {
  return raw.trim().replace(/\\/gu, '/').replace(/^[A-Za-z]:/u, '').toLowerCase()
}

function baseName(normalized: string): string {
  const cut = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf(':'))
  return cut === -1 ? normalized : normalized.slice(cut + 1)
}

/**
 * Classify a single path. `undefined` means "no credential shape here" — this
 * is deliberately not a security verdict, just a fact the gate acts on.
 */
export function classifySensitivePath(rawPath: string): SensitiveTarget | undefined {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') return undefined
  const normalized = normalize(rawPath)
  const base = baseName(normalized)
  for (const matcher of MATCHERS) {
    if (matcher.test(normalized, base)) return { kind: matcher.kind, target: rawPath }
  }
  return undefined
}

/** First credential-shaped target among a tool call's path arguments. */
export function firstSensitivePath(paths: readonly string[]): SensitiveTarget | undefined {
  for (const path of paths) {
    const hit = classifySensitivePath(path)
    if (hit !== undefined) return hit
  }
  return undefined
}

/**
 * Shell commands are their own leak path: `cat ~/.ssh/id_rsa` is shorter than
 * the read-prefix allowlist and never becomes a path argument of any tool.
 * Scanned on the raw command text — a token-level parse would be more precise
 * and also wrong more often, because shells mangle paths before exec.
 */
export function commandTouchesSensitivePath(command: string): SensitiveTarget | undefined {
  if (typeof command !== 'string' || command.trim() === '') return undefined
  for (const token of command.split(/[\s"'`;|&()<>]+/u)) {
    if (token === '') continue
    const hit = classifySensitivePath(token)
    if (hit !== undefined) return hit
  }
  return undefined
}
