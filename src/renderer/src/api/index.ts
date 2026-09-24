import type { CodexApi, MarketplaceApi } from '../types'
import { MockCodexApi } from './mock'
import { MockMarketplaceApi } from './mockMarketplace'

function createMockCodex(): MockCodexApi {
  return new MockCodexApi()
}

const codexApi: CodexApi = window.electron?.codex ?? createMockCodex()

const marketplaceApi: MarketplaceApi =
  window.electron?.marketplace ??
  new MockMarketplaceApi({
    adopt: (detail) => {
      if (codexApi instanceof MockCodexApi) codexApi.adoptPlugin(detail)
    },
    installedVersion: (name) =>
      codexApi instanceof MockCodexApi ? codexApi.installedVersionOf(name) : null
  })

export { codexApi, marketplaceApi }
