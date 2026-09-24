import type { CodexApi, MarketplaceApi } from '../../shared/contract'

declare global {
  interface Window {
    electron?: {
      codex?: CodexApi
      marketplace?: MarketplaceApi
    }
  }
}

export {}
