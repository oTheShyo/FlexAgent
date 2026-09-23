import type { CodexApi } from '../types'
import { MockCodexApi } from './mock'

export const codexApi: CodexApi = window.electron?.codex ? window.electron.codex : new MockCodexApi()
