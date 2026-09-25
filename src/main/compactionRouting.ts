/**
 * Route context compaction to a model of its own.
 *
 * Compaction is a different job from the conversation: it reads a long
 * transcript and writes one faithful summary, once, while the user waits for
 * the next turn. PI binds it hard to the session model (`compact()` is called
 * with `this.model`), which is the wrong default when the conversation runs on
 * a small fast model and the transcript has outgrown it.
 *
 * PI exposes no "compaction model" setting, so this rides the
 * `session_before_compact` hook instead: the hook is handed the fully prepared
 * work (`preparation` — cut point, messages to summarise, reserve tokens, file
 * ops) and may return the finished `CompactionResult`. Re-running PI's own
 * `compact()` with a different model therefore changes *only* the model; the
 * cut point, the merging of a split turn, the file-operation footer and the
 * usage accounting all stay PI's.
 *
 * Returning `undefined` means "not routed" and hands the work back to PI
 * untouched — that is the path taken when no compaction model is configured, so
 * an unconfigured app behaves exactly as before.
 */
import type { InlineExtension, ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { SessionBeforeCompactEvent } from '@earendil-works/pi-coding-agent'

type KernelModel = NonNullable<ReturnType<ModelRuntime['getModel']>>
type CompactPreparation = SessionBeforeCompactEvent['preparation']

/**
 * Sent to the summariser as the compaction's "Additional focus" (see
 * COMPACTION_FOCUS below). PI's own summarisation prompt only tells the model
 * not to continue the conversation; it says nothing about tools, and nothing
 * about what survives. The whole point of the transaction is that the
 * transcript is dropped afterwards, so the summary is the only thing the next
 * turn has to work from.
 *
 * PI appends this rather than replacing its prompt, so the two do not fight:
 * its guard line stays, and this adds the rest.
 */
const COMPACTION_FOCUS = [
  'Summarise only. Call no tools, read no files, answer no question, and write no reply to the user: the transcript ends here and this summary is all that carries forward.',
  'Output one block of plain prose — no headings, no bullet lists, no preamble about summarising.',
  'Preserve: file paths with line numbers, every decision plus the evidence behind it, identifiers and command output that re-deriving would cost a turn, and any claim that is still unverified.',
  'Drop: narration about what you were doing, replays of long command output (keep the result, not the log), and anything already stated in the previous summary.'
].join(' ')

export interface CompactionRoutingDeps {
  /** The configured compaction model, or `null` to leave PI's choice alone. */
  resolveCompactionModel: () => Promise<KernelModel | null>
  /** The shared runtime, for that model's credentials. */
  getRuntime: () => Promise<ModelRuntime>
  /**
   * Observability hook (docs/observability.md §4): every routing attempt, so
   * compaction cost and fallbacks are answerable offline. Optional — the
   * extension stays usable without the sink.
   */
  observe?: (info: { model: string; durationMs: number; ok: boolean; note?: string }) => void
}

/**
 * The value handed to `compact()` as its focus.
 *
 * Split out and exported so the channel can be checked without a session: it
 * was wired to `event.customInstructions` and left that undefined everywhere,
 * which fails silently — the summary still gets written, just with no format
 * promise and no instruction about what to keep.
 */
export function compactionFocus(event: SessionBeforeCompactEvent): string {
  const explicit = event.customInstructions
  if (explicit === undefined || explicit === '') return COMPACTION_FOCUS
  return `${COMPACTION_FOCUS} The requesting agent asked to focus on: ${explicit}`
}

/** PI drops headers whose value is empty; mirror that rather than sending "null". */
function definedHeaders(
  headers: Record<string, string | null | undefined> | undefined
): Record<string, string> | undefined {
  if (headers === undefined) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function createCompactionRoutingExtension(deps: CompactionRoutingDeps): InlineExtension {
  return {
    name: 'flex-compaction-routing',
    factory: (pi): void => {
      pi.on('session_before_compact', async (event) => {
        const started = Date.now()
        const model = await deps.resolveCompactionModel()
        if (model === null) {
          deps.observe?.({
            model: 'session-model',
            durationMs: Date.now() - started,
            ok: true,
            note: 'no compaction model configured — PI compacts with the session model'
          })
          return undefined
        }
        const runtime = await deps.getRuntime()
        let requestModel = model
        let apiKey: string | undefined
        let headers: Record<string, string> | undefined
        let env: Record<string, string> | undefined
        try {
          const resolved = await runtime.getAuth(model, { signal: event.signal })
          if (resolved === undefined) return undefined
          apiKey = resolved.auth.apiKey
          headers = definedHeaders(resolved.auth.headers)
          env = resolved.env
          if (resolved.auth.baseUrl !== undefined) {
            requestModel = { ...model, baseUrl: resolved.auth.baseUrl }
          }
        } catch (err) {
          if (event.signal.aborted) throw err
          // No usable credential for the routed model. PI's own path still works,
          // and the Settings panel reports an unroutable binding rather than
          // hiding it — a warning here keeps the fallback out of the dark.
          console.warn(
            `[compaction-routing] no credentials for ${model.provider}/${model.id}; using the session model`
          )
          deps.observe?.({
            model: `${model.provider}/${model.id}`,
            durationMs: Date.now() - started,
            ok: false,
            note: 'no credentials — fell back to the session model'
          })
          return undefined
        }
        try {
          const { compact } = await import('@earendil-works/pi-coding-agent')
          // An explicit instruction from whoever asked for the compaction wins
          // on scope, but it is appended rather than replacing the focus: the
          // summariser has to keep the output-format promise either way.
          const focus = compactionFocus(event)
          const result = await compact(
            event.preparation as CompactPreparation,
            requestModel,
            apiKey,
            headers,
            focus,
            event.signal,
            undefined,
            undefined,
            env,
            undefined,
            undefined,
            undefined
          )
          deps.observe?.({
            model: `${model.provider}/${model.id}`,
            durationMs: Date.now() - started,
            ok: true
          })
          return { compaction: result }
        } catch (err) {
          if (event.signal.aborted) throw err
          console.warn(
            `[compaction-routing] ${model.provider}/${model.id} failed (${err instanceof Error ? err.message : String(err)}); using the session model`
          )
          deps.observe?.({
            model: `${model.provider}/${model.id}`,
            durationMs: Date.now() - started,
            ok: false,
            note: `compact() failed — fell back to the session model`
          })
          return undefined
        }
      })
    }
  }
}
