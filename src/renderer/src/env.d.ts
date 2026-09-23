import type { CodexApi } from '../../shared/contract'

declare global {
  interface Window {
    electron?: {
      codex?: CodexApi
    }
  }
}

export {}
