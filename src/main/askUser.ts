/**
 * The `ask_user` tool: how the agent stops and asks (issue 10).
 *
 * Without a tool there is nothing to put a countdown on — the agent would have
 * to ask in prose, which cannot be blocked on, cannot be timed out, and cannot
 * be marked "answered" in the transcript. So the question is a tool call that
 * suspends the run exactly like a permission prompt does.
 *
 * The tool itself knows nothing about timers or UI: it hands the question to the
 * worker and awaits an answer. Everything about *how long* the user gets, and
 * what happens when they don't answer, is decided on the worker side so that the
 * setting can be honoured per question.
 */
import type { InlineExtension } from '@earendil-works/pi-coding-agent'

export interface AskUserRequest {
  prompt: string
  options: string[]
}

export interface AskUserAnswer {
  /** The chosen option, free text, or null when nobody answered in time. */
  answer: string | null
  timedOut: boolean
}

export interface AskUserHooks {
  /** Resolves when the user answers, the countdown expires, or the run dies. */
  ask: (request: AskUserRequest) => Promise<AskUserAnswer>
}

const ASK_USER_SCHEMA = {
  type: 'object',
  properties: {
    question: {
      type: 'string',
      description: 'The question to show the user. One decision, phrased so it can be answered from the options.'
    },
    options: {
      type: 'array',
      description: 'Two to four answers to choose from. The user may still type something else.',
      items: { type: 'string' },
      minItems: 2,
      maxItems: 4
    }
  },
  required: ['question', 'options'],
  additionalProperties: false
} as const

function textResult(text: string): { content: { type: 'text'; text: string }[]; details: unknown } {
  return { content: [{ type: 'text', text }], details: {} }
}

export function createAskUserExtension(hooks: AskUserHooks): InlineExtension {
  return {
    name: 'flex-ask-user',
    factory: (pi): void => {
      pi.registerTool({
        name: 'ask_user',
        label: 'Ask user',
        description:
          'Ask the user to choose between options and wait for the answer. ' +
          'Use it when the next step genuinely depends on a decision only they can make ' +
          '(which approach, which file, which trade-off) — not for confirmation you could ' +
          'reasonably assume, and not while a permission request is already pending. ' +
          'If nobody answers in time the run continues and you will be told that: proceed ' +
          'with your own judgement and say which option you took.',
        promptSnippet: 'ask_user: stop and ask the user to choose between 2-4 options',
        promptGuidelines: [
          'When a decision is genuinely the user\'s to make, call ask_user with concrete options instead of guessing and instead of asking in prose.'
        ],
        parameters: ASK_USER_SCHEMA,
        execute: async (_toolCallId, rawParams): Promise<ReturnType<typeof textResult>> => {
          const params =
            rawParams !== null && typeof rawParams === 'object'
              ? (rawParams as Record<string, unknown>)
              : {}
          const question = typeof params.question === 'string' ? params.question.trim() : ''
          if (question.length === 0) {
            return textResult('ask_user requires a non-empty question')
          }
          const options = Array.isArray(params.options)
            ? params.options.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            : []
          if (options.length < 2) {
            return textResult('ask_user requires at least two options')
          }
          try {
            const outcome = await hooks.ask({ prompt: question, options })
            if (outcome.timedOut) {
              return textResult(
                'No answer: the question timed out and the run continued. ' +
                  'Pick the option you judge best, say which one you took and why, and keep going.'
              )
            }
            return textResult(`The user answered: ${outcome.answer ?? ''}`)
          } catch (err) {
            // Never let a failed question kill the run: the agent continues
            // without an answer, which is the same outcome as a timeout.
            return textResult(
              `ask_user could not be shown (${err instanceof Error ? err.message : String(err)}). ` +
                'Continue with your own judgement.'
            )
          }
        }
      })
    }
  }
}
