/**
 * Sensitive-value detection for **output** filtering (security §敏感信息输出过滤).
 *
 * Security is not only about guarding input: a tool call can read a file or an
 * environment variable that happens to contain a credential, and whatever the
 * tool returns is then (a) sent to the model provider and (b) echoed into the
 * transcript the user sees. Both are leaks. Everything that crosses those two
 * boundaries passes through `redactSecrets` first.
 *
 * Design stance, following the article: **prefer over-filtering**. A masked
 * string costs a re-read; a leaked key costs money and can be used against the
 * user. False positives are therefore accepted, but the pattern set is still
 * shaped to avoid the two cheapest mistakes:
 *
 * 1. Only *values*, never bare keywords, are masked — "rotate the api key" is
 *    normal technical prose and must survive.
 * 2. Value shapes must look like credentials (length + charset), not like
 *    ordinary words, so reading a config file does not become unreadable.
 *
 * The patterns mirror `memoryLint.ts` (which rejects the same shapes when the
 * model tries to *store* them) but are stricter here because this runs on every
 * tool result and cannot afford to shred normal output.
 */

export interface RedactionHit {
  kind: string
  /** Masked preview length — enough to audit "something was here", not the value. */
  length: number
}

export interface RedactionResult {
  text: string
  hits: RedactionHit[]
}

export const REDACTION_MARK = '[[redacted]]'

interface Rule {
  kind: string
  pattern: RegExp
  /** Replacement receives the match; default is `${REDACTION_MARK}:kind`. */
  replace?: (match: string, ...groups: string[]) => string
}

/** Makers of well-known credential formats — no separator needed, the prefix is the evidence. */
const PREFIX_RULES: Rule[] = [
  { kind: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { kind: 'openai-key', pattern: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g },
  { kind: 'gitlab-token', pattern: /\bglpat-[A-Za-z0-9_-]{16,}/g },
  { kind: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { kind: 'google-oauth', pattern: /\bya29\.[0-9A-Za-z_-]{20,}/g },
  { kind: 'huggingface-token', pattern: /\bhf_[A-Za-z0-9]{20,}/g },
  { kind: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{30,}/g },
  { kind: 'pypi-token', pattern: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{10,}/g },
  { kind: 'slack-webhook', pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_+-]{20,}/g },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    kind: 'private-key',
    pattern: /-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----[\s\S]*?-----END [A-Z ]{0,30}PRIVATE KEY-----/g
  }
]

/**
 * `name = value` / `"name": "value"` forms. The keyword list is explicit — a
 * generic "any word followed by a long string" rule would mask half of a normal
 * source file.
 */
const ASSIGNMENT_KEYWORDS =
  '(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|client[_-]?secret|private[_-]?key|' +
  'password|passwd|passphrase|auth[_-]?token|access[_-]?token|refresh[_-]?token|bearer[_-]?token|' +
  'credential|authorization)'

/**
 * Values that *point at* a secret rather than containing one. Masking these
 * would be actively harmful: `apiKey: process.env.OPENAI_API_KEY` is the shape
 * we want people to use, and shredding it teaches the model that the safe
 * pattern is what gets censored.
 */
const VALUE_INDIRECTION =
  /^(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|process\.env\.[A-Za-z0-9_.]+|<[^>]*>|x{6,}|\.{3,}|your[_-][A-Za-z0-9_-]*|changeme|change[_-]?me|placeholder|redacted|todo|tbd|example|none|null|undefined)$/i

const ASSIGNMENT_RULES: Rule[] = [
  {
    kind: 'credential-assignment',
    // Quoted values may contain spaces (passphrases); unquoted ones may not.
    pattern: new RegExp(
      `(${ASSIGNMENT_KEYWORDS}\\s*[:=]\\s*)(["']?)([^\\s"',;]{12,})\\2`,
      'gi'
    ),
    replace: (match, prefix, quote, value: string) => {
      const bare = value.trim()
      if (VALUE_INDIRECTION.test(bare)) return match
      // An unquoted bare identifier (`apiKey = configSecret`) is a pointer to a
      // value defined elsewhere. Quoted values keep the benefit of the doubt —
      // an all-lowercase 16-char string in quotes is far more likely a key than
      // a variable name.
      if (quote === '' && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(bare) && !/[0-9]/u.test(bare)) return match
      return `${prefix}${quote}${REDACTION_MARK}:value${quote}`
    }
  },
  {
    kind: 'env-assignment',
    // .env style: KEY_WITH_SECRET_IN_NAME=longvalue
    pattern: /^([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|CREDENTIAL)[A-Z0-9_]*)=(.{12,})$/gim,
    replace: (_match, name: string, value: string) =>
      VALUE_INDIRECTION.test(value.trim()) ? _match : `${name}=${REDACTION_MARK}:env-value`
  },
  {
    kind: 'authorization-header',
    pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
    replace: (_match, prefix: string) => `${prefix}${REDACTION_MARK}:bearer`
  },
  {
    // URL userinfo — the host stays readable, only the password is masked.
    kind: 'url-credential',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s:/@]{3,})(@)/gi,
    replace: (_match, prefix: string, _password: string, at: string) =>
      `${prefix}${REDACTION_MARK}:password${at}`
  }
]

const ALL_RULES: Rule[] = [...PREFIX_RULES, ...ASSIGNMENT_RULES]

function markFor(kind: string): string {
  return `${REDACTION_MARK}:${kind}`
}

/**
 * Mask every credential-shaped value in `text`. Returns the text unchanged
 * (same string identity) when nothing matched, so hot paths can skip work.
 */
export function redactSecrets(text: string): RedactionResult {
  if (text.length === 0) return { text, hits: [] }
  let out = text
  const hits: RedactionHit[] = []
  for (const rule of ALL_RULES) {
    // Global regexes are stateful; `replace` resets lastIndex itself, but a
    // fresh source of truth per call keeps this safe under concurrent use.
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags)
    out = out.replace(pattern, (...args: unknown[]) => {
      const match = String(args[0])
      const groups = args.slice(1, -2) as string[]
      const replaced = rule.replace !== undefined ? rule.replace(match, ...groups) : markFor(rule.kind)
      // A rule may decline a match (env indirection, a pointer variable). Those
      // are not hits: reporting them would inflate the audit trail with
      // non-events and train readers to ignore it.
      if (replaced === match) return match
      hits.push({ kind: rule.kind, length: match.length })
      return replaced
    })
  }
  return { text: out, hits }
}

/** Kinds of secrets present in the text, deduplicated — used for audit entries. */
export function findSecretKinds(text: string): string[] {
  return [...new Set(redactSecrets(text).hits.map((hit) => hit.kind))]
}
