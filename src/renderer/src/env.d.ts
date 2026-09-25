import type { CodexApi, MarketplaceApi, WindowControlsApi } from '../../shared/contract'

declare global {
  interface Window {
    electron?: {
      codex?: CodexApi
      marketplace?: MarketplaceApi
      windowControls?: WindowControlsApi
    }
  }
}

export {}
