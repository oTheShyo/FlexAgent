/**
 * Similarity machinery for curated memory cards.
 *
 * Dedupe has three bands, because one strategy cannot serve all three:
 *
 *   score >= DUPLICATE_THRESHOLD  decide locally — it is the same sentence
 *   CANDIDATE <= score < DUPLICATE ask a small model (the semantic middle band)
 *   score < CANDIDATE             unrelated, let it through untouched
 *
 * The point of the bands is that the expensive step is rare and bounded: it
 * only runs when a rule says "these are suspiciously close but not identical",
 * and even then it sees at most MAX_JUDGE_CANDIDATES candidates — never the
 * whole store. That is the difference between "linear in how much you
 * remember" and "flat".
 */

/** Same fact rephrased: high enough that a model would add nothing. */
export const DUPLICATE_THRESHOLD = 0.9

/** Below this the two strings share nothing worth judging. */
export const CANDIDATE_THRESHOLD = 0.42

export const MAX_JUDGE_CANDIDATES = 4

/** Below this length bigrams are noise: "npm" and "nvm" score high and mean nothing. */
const MIN_TEXT_LENGTH = 6

/** Two cards sharing this many content words are candidates regardless of score. */
const TOPIC_OVERLAP = 2

/** Words too common to say anything about what a card is *about*. */
const WEAK_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'then', 'when', 'not',
  'are', 'was', 'were', 'has', 'have', 'had', 'can', 'does', 'did', 'but', 'its', 'his',
  'her', 'their', 'you', 'your', 'they', 'them', 'over', 'than', 'also', 'been', 'more',
  'any', 'all', 'use', 'used', 'using', 'should', 'would', 'could', 'each', 'per'
])

/** Length ratio guard: a one-line note and a paragraph are rarely the same fact. */
const LENGTH_RATIO_LIMIT = 2.5

/**
 * Deliberately crude stemming: enough to fold "answers" into "answer" and
 * "tables" into "table", which is where most English topic overlap is lost. Not
 * enough to be right in general — a wrong fold here only adds a candidate, and
 * candidates are cheap.
 */
function stem(word: string): string {
  if (word.length < 5) return word
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.endsWith('sses')) return word.slice(0, -2)
  return /[^s]s$/.test(word) ? word.slice(0, -1) : word
}

function contentWords(text: string): Set<string> {
  const words = new Set<string>()
  for (const match of text.toLowerCase().matchAll(/[a-z_][a-z0-9_]{2,}|[\u4e00-\u9fff]{2,}/g)) {
    const word = match[0]
    if (!WEAK_WORDS.has(word)) words.add(stem(word))
  }
  return words
}

function sharedContentWords(a: string, b: string): number {
  const left = contentWords(a)
  let shared = 0
  for (const word of contentWords(b)) if (left.has(word)) shared += 1
  return shared
}

/** True when the two are close enough in size to plausibly be the same claim. */
function comparableLength(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a.length, b.length] : [b.length, a.length]
  return short > 0 && long / short <= LENGTH_RATIO_LIMIT
}

export interface SimilarityHit {
  index: number
  score: number
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '')
}

function bigrams(text: string): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i < text.length - 1; i += 1) out.add(text.slice(i, i + 2))
  return out
}

/**
 * Dice coefficient over character bigrams. Character-level on purpose: these
 * cards mix Chinese and English, and neither a word tokenizer nor an embedding
 * call is justified for deciding whether two one-line notes agree.
 */
export function similarity(a: string, b: string): number {
  const left = normalize(a)
  const right = normalize(b)
  if (left.length < MIN_TEXT_LENGTH || right.length < MIN_TEXT_LENGTH) {
    return left === right ? 1 : 0
  }
  const leftGrams = bigrams(left)
  const rightGrams = bigrams(right)
  let shared = 0
  for (const gram of leftGrams) if (rightGrams.has(gram)) shared += 1
  if (shared === 0) return 0
  return (2 * shared) / (leftGrams.size + rightGrams.size)
}

/**
 * Candidates worth asking a model about, highest first, capped.
 *
 * Two independent signals, unioned. Character similarity catches edits and
 * rewordings of the same words; topic overlap catches rewrites that share no
 * phrasing ("prefers tables" vs "likes answers in tables"). Lexical measures
 * alone miss the second kind entirely — which is the kind a memory store ends
 * up full of.
 *
 * Over-including is the right error here: a spurious candidate costs one small
 * model call that answers "not a duplicate", while a missed one leaves a
 * duplicate in the store forever.
 */
export function candidatesAmong(text: string, existing: string[]): SimilarityHit[] {
  const hits: SimilarityHit[] = []
  existing.forEach((other, index) => {
    const score = similarity(text, other)
    const lexicalBand = score >= CANDIDATE_THRESHOLD && score < DUPLICATE_THRESHOLD
    const topical =
      score < DUPLICATE_THRESHOLD &&
      sharedContentWords(text, other) >= TOPIC_OVERLAP &&
      comparableLength(text, other)
    if (lexicalBand || topical) hits.push({ index, score })
  })
  return hits.sort((a, b) => b.score - a.score).slice(0, MAX_JUDGE_CANDIDATES)
}

/** True when text is a near-enough restatement of something already stored. */
export function findLocalDuplicate(text: string, existing: string[]): number | undefined {
  let bestIndex: number | undefined
  let bestScore = DUPLICATE_THRESHOLD
  existing.forEach((other, index) => {
    const score = similarity(text, other)
    if (score >= bestScore) {
      bestScore = score
      bestIndex = index
    }
  })
  return bestIndex
}

export function buildJudgePrompt(newText: string, candidates: string[]): string {
  const numbered = candidates.map((text, i) => `${i + 1}. ${text}`).join('\n')
  return [
    'You are deciding whether a new memory card duplicates an existing one.',
    'Two cards are duplicates when a future reader would act the same way knowing either of them.',
    'They are NOT duplicates merely because they touch the same topic.',
    '',
    'Existing cards:',
    numbered,
    '',
    `New card: ${newText}`,
    '',
    `Reply with the number of the duplicate (1-${candidates.length}), or 0 if it is genuinely new. Reply with only that digit.`
  ].join('\n')
}

/**
 * Parse the judge reply. Anything unexpected becomes `null`, which callers
 * treat as "no decision" and let the card through — an unavailable or confused
 * judge must never cost the user a real memory.
 */
export function parseJudgeReply(raw: string, candidateCount: number): number | null {
  const trimmed = raw.trim()
  // A leading or trailing bare digit only. "I think 2 is close" is NOT treated
  // as selecting 2: the whole point of asking is to avoid guessing, and pulling
  // a number out of a sentence is guessing — with a card's deletion as the cost.
  const match = /^(\d{1,2})\.?$/.exec(trimmed)
  if (match === null) return null
  const value = Number(match[1])
  if (value < 0 || value > candidateCount) return null
  return value === 0 ? null : value - 1
}
