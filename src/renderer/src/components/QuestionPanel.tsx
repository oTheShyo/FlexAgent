import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { QuestionNotice } from '../hooks/useChat'
import { InfoIcon } from './icons'

export interface QuestionPanelProps {
  question: QuestionNotice
  onAnswer: (questionId: string, answer: string) => void
  /** Stop the countdown for good. Called on the first interaction of any kind. */
  onStopTimer: (questionId: string) => void
}

function remainingOf(question: QuestionNotice, now: number): number {
  if (question.expiresAt === null) return 0
  return Math.max(0, question.expiresAt - now)
}

function formatRemaining(ms: number): string {
  const total = Math.ceil(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * The agent's question, with its countdown (issue 10).
 *
 * Two rules shape this component:
 *
 * 1. Any interaction stops the clock permanently — hovering included. A
 *    countdown that resumes while the user is reading is a countdown that can
 *    answer for them, and the whole point of the deadline is that it only fires
 *    when nobody is there.
 * 2. Permission prompts and plan approvals never get one of these. They are
 *    separate UI with no deadline, because "silently allowed" is not an
 *    acceptable default for either.
 */
export function QuestionPanel({ question, onAnswer, onStopTimer }: QuestionPanelProps): ReactNode {
  const [draft, setDraft] = useState('')
  const [remaining, setRemaining] = useState(() => remainingOf(question, Date.now()))
  const stoppedRef = useRef(false)

  const stopTimer = (): void => {
    if (stoppedRef.current) return
    stoppedRef.current = true
    onStopTimer(question.questionId)
  }

  useEffect(() => {
    stoppedRef.current = false
    setDraft('')
    if (question.expiresAt === null) {
      setRemaining(0)
      return
    }
    setRemaining(remainingOf(question, Date.now()))
    const timer = window.setInterval(() => {
      setRemaining(remainingOf(question, Date.now()))
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [question.questionId, question.expiresAt])

  const counting = question.expiresAt !== null && !stoppedRef.current && remaining > 0

  const submit = (answer: string): void => {
    const trimmed = answer.trim()
    if (trimmed.length === 0) return
    stopTimer()
    onAnswer(question.questionId, trimmed)
  }

  return (
    <div
      className="mx-auto w-full max-w-3xl px-4 pb-2"
      data-testid="question-panel"
      onMouseEnter={stopTimer}
      onFocus={stopTimer}
      onClick={stopTimer}
    >
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
        <div className="flex items-start gap-2.5">
          <InfoIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" />
          <div className="min-w-0 flex-1">
            <p className="text-sm leading-5 text-[var(--text)]">{question.prompt}</p>

            <div className="mt-2.5 flex flex-col gap-1.5">
              {question.options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => submit(option.label)}
                  data-testid={`question-option-${option.id}`}
                  className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-left text-xs text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--hover)]"
                >
                  {option.label}
                </button>
              ))}
            </div>

            <form
              className="mt-2.5 flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                submit(draft)
              }}
            >
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Or type your own answer"
                aria-label="Your answer"
                data-testid="question-free-text"
                className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] px-2.5 py-1.5 text-xs text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              />
              <button
                type="submit"
                disabled={draft.trim().length === 0}
                className="shrink-0 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--text)] disabled:opacity-40"
              >
                Send
              </button>
            </form>

            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="text-[11px] leading-4 text-[var(--text-muted)]">
                {question.expiresAt === null
                  ? 'Waiting for your answer.'
                  : counting
                    ? 'Continues on its own if you do not answer.'
                    : 'Countdown stopped — it will wait for you.'}
              </span>
              {question.expiresAt !== null && (
                <button
                  type="button"
                  onClick={stopTimer}
                  data-testid="question-remaining"
                  className="shrink-0 text-[11px] tabular-nums text-[var(--text-muted)] hover:text-[var(--text)]"
                  title="Stop the countdown"
                >
                  {counting ? `${formatRemaining(remaining)} left` : 'stopped'}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default QuestionPanel
