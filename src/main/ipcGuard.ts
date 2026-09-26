/**
 * Unified IPC sender validation (issue 21) — the single registration point for
 * ipcMain handlers. ipc.ts / marketplaceIpc.ts / permissionRulesIpc.ts import
 * `ipcMain` from here instead of from 'electron', so every handler refuses
 * senders that are not this app's own windows rendering this app's own
 * renderer (docs security §Electron 边界).
 *
 * What gets rejected, and why that is the right default:
 *  - devtools: its WebContents belongs to no BrowserWindow, so an attacker (or
 *    a curious dev) typing IPC into the console hits the guard. Packaged apps
 *    close devtools outright (index.ts); dev keeps the friction on purpose.
 *  - injected iframes / external navigations: `event.senderFrame.url` is the
 *    calling frame's URL, so only frames rendering our renderer pass. The
 *    window-open deny + will-navigate guard + CSP keep those frames from
 *    existing in the first place — this is the belt to those suspenders.
 *  - other apps' windows: Electron single-instance means there shouldn't be
 *    any, but `BrowserWindow.fromWebContents` still gates it.
 *
 * Rejections are thrown (invoke handlers surface a rejected promise to the
 * renderer) and logged with the channel + offending URL for diagnosis.
 */
import { BrowserWindow, ipcMain as rawIpcMain } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { fileURLToPath } from 'url'
import { join, sep } from 'path'

// ---------------------------------------------------------------------------
// Pure verdict logic — unit-testable without booting Electron.
// ---------------------------------------------------------------------------

export interface SenderVerdict {
  ok: boolean
  reason?: string
}

export interface SenderFacts {
  /** The sender WebContents is one of this app's BrowserWindows. */
  senderBelongsToAppWindow: boolean
  /** `event.senderFrame?.url` — null when the frame vanished mid-call. */
  frameUrl: string | null
  /** Dev renderer origin (vite), e.g. `http://localhost:5173`. Absent when packaged. */
  devRendererUrl?: string
  /** Directory of the packaged renderer bundle (`out/renderer`). Absent in dev. */
  rendererRoot?: string
}

export function evaluateSender(facts: SenderFacts): SenderVerdict {
  if (!facts.senderBelongsToAppWindow) {
    return {
      ok: false,
      reason: 'sender is not one of this app\'s windows (devtools, webview, or another application)'
    }
  }
  if (facts.frameUrl === null) {
    return { ok: false, reason: 'sender frame no longer exists' }
  }
  const url = facts.frameUrl
  if (facts.devRendererUrl) {
    // Compare origins, not string prefixes: `startsWith` would let
    // `http://localhost:5173.evil.example` impersonate the dev server.
    try {
      if (new URL(url).origin === new URL(facts.devRendererUrl).origin) return { ok: true }
    } catch {
      // Unparseable URL — fall through to reject.
    }
  }
  if (url.startsWith('file://')) {
    // The trailing separator matters: `…/out/renderer` must not prefix-match
    // an attacker directory like `…/out/renderer-evil`.
    const roots = facts.rendererRoot
      ? [facts.rendererRoot + sep, facts.rendererRoot + '/']
      : []
    for (const root of roots) {
      try {
        if (fileURLToPath(url).startsWith(root)) return { ok: true }
      } catch {
        // Malformed file URL — fall through to reject.
      }
    }
  }
  return { ok: false, reason: `calling frame is not this app's renderer: ${url}` }
}

// ---------------------------------------------------------------------------
// Electron wiring.
// ---------------------------------------------------------------------------

/** Same layout rule as index.ts: main bundle sits next to the renderer output. */
function rendererRoot(): string {
  return join(__dirname, '..', 'renderer')
}

function isAppWindowContents(sender: WebContents): boolean {
  const win = BrowserWindow.fromWebContents(sender)
  return win !== null && !win.isDestroyed()
}

function safeFrameUrl(event: IpcMainInvokeEvent | IpcMainEvent): string | null {
  try {
    return event.senderFrame?.url ?? null
  } catch {
    // Electron throws when the frame is already disposed.
    return null
  }
}

function verdictFor(event: IpcMainInvokeEvent | IpcMainEvent): SenderVerdict {
  return evaluateSender({
    senderBelongsToAppWindow: isAppWindowContents(event.sender),
    frameUrl: safeFrameUrl(event),
    devRendererUrl: process.env.ELECTRON_RENDERER_URL,
    rendererRoot: process.env.ELECTRON_RENDERER_URL ? undefined : rendererRoot()
  })
}

type InvokeListener = (event: IpcMainInvokeEvent, ...args: any[]) => any
type EventListener = (event: IpcMainEvent, ...args: any[]) => void

function guardInvoke(channel: string, listener: InvokeListener): InvokeListener {
  return (event, ...args) => {
    const verdict = verdictFor(event)
    if (!verdict.ok) {
      console.warn(`[ipc] rejected ${channel}: ${verdict.reason}`)
      throw new Error(`IPC sender rejected for ${channel}: ${verdict.reason}`)
    }
    return listener(event, ...args)
  }
}

function guardEvent(channel: string, listener: EventListener): EventListener {
  return (event, ...args) => {
    const verdict = verdictFor(event)
    if (!verdict.ok) {
      console.warn(`[ipc] rejected ${channel}: ${verdict.reason}`)
      return
    }
    listener(event, ...args)
  }
}

/**
 * Drop-in subset of Electron's ipcMain with the guard on every registration
 * path. Keep this list in sync with what the ipc modules actually use; adding
 * a new method here is the review checkpoint for "can this channel be
 * registered without sender validation?"
 */
export const ipcMain = {
  handle(channel: string, listener: InvokeListener): void {
    rawIpcMain.handle(channel, guardInvoke(channel, listener))
  },
  handleOnce(channel: string, listener: InvokeListener): void {
    rawIpcMain.handleOnce(channel, guardInvoke(channel, listener))
  },
  on(channel: string, listener: EventListener): void {
    rawIpcMain.on(channel, guardEvent(channel, listener))
  },
  once(channel: string, listener: EventListener): void {
    rawIpcMain.once(channel, guardEvent(channel, listener))
  },
  removeHandler(channel: string): void {
    rawIpcMain.removeHandler(channel)
  },
  removeAllListeners(channel: string): void {
    rawIpcMain.removeAllListeners(channel)
  }
}
