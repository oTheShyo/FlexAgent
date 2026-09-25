import { Component } from 'react'
import type { ReactNode } from 'react'
import { Button } from './ui'

export interface ErrorBoundaryProps {
  children: ReactNode
  /**
   * Size/layout classes for the fallback root. Defaults to fill the parent
   * (works inside the scrollable main column). Pass explicit sizing when the
   * boundary sits in a constrained slot (e.g. the sidebar).
   */
  fallbackClassName?: string
}

interface ErrorBoundaryState {
  error: Error | null
}

const FALLBACK_BASE =
  'flex flex-col items-center justify-center gap-4 bg-[var(--surface)] px-6 py-10 text-center'
const FALLBACK_DEFAULT_SIZE = 'h-full min-h-[240px] w-full'

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  private readonly handleReload = (): void => {
    window.location.reload()
  }

  private readonly handleRetry = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (error !== null) {
      const size = this.props.fallbackClassName ?? FALLBACK_DEFAULT_SIZE
      return (
        <div
          role="alert"
          data-testid="error-boundary"
          className={`${FALLBACK_BASE} ${size}`}
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] text-[var(--text-muted)]">
            <svg
              className="h-5 w-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            </svg>
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight text-[var(--text)]">
              Something went wrong
            </h1>
            <p className="mx-auto mt-1 max-w-sm text-sm leading-5 text-[var(--text-muted)]">
              This part of the app hit an unexpected error. Try again to
              re-render it, or reload the app to start fresh.
            </p>
            {error.message.length > 0 && (
              <p className="mx-auto mt-2 max-w-sm break-all font-mono text-xs leading-4 text-[var(--text-subtle)]">
                {error.message}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              data-testid="error-boundary-retry"
              onClick={this.handleRetry}
            >
              Try again
            </Button>
            <Button
              type="button"
              variant="primary"
              data-testid="error-boundary-reload"
              onClick={this.handleReload}
            >
              Reload
            </Button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

export default ErrorBoundary
