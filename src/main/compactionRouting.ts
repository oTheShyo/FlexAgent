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

export interface CompactionRoutingDeps {
  /** The configured compaction model, or `null` to leave PI's choice alone. */
  resolveCompactionModel: () => Promise<KernelModel | null>
  /** The shared runtime, for that model's credentials. */
  getRuntime: () => Promise<ModelRuntime>
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
        const model = await deps.resolveCompactionModel()
        if (model === null) return undefined
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
          return undefined
        }
        try {
          const { compact } = await import('@earendil-works/pi-coding-agent')
          const result = await compact(
            event.preparation as CompactPreparation,
            requestModel,
            apiKey,
            headers,
            event.customInstructions,
            event.signal,
            undefined,
            undefined,
            env,
            undefined,
            undefined,
            undefined
          )
          return { compaction: result }
        } catch (err) {
          if (event.signal.aborted) throw err
          console.warn(
            `[compaction-routing] ${model.provider}/${model.id} failed (${err instanceof Error ? err.message : String(err)}); using the session model`
          )
          return undefined
        }
      })
    }
  }
}
