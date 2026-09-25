import { app, BrowserWindow, Menu } from 'electron'
import { join } from 'path'
import { enableCompileCache, getCompileCacheDir } from 'node:module'
import { registerIpcHandlers } from './ipc'
import { KernelHost } from './kernel'
import { perfStart } from './perf'
import { SessionRegistry } from './registry'
import { TerminalManager } from './pty'
import { PluginRegistry, pluginsStorageRoot } from './pluginRegistry'
import { PluginService } from './plugins'
import { UserMcpService } from './userMcp'
import { UserModelsService } from './userModels'
import { KernelSettingsService } from './kernelSettings'
import { scratchCwd } from './workspace'
import { MarketplaceService } from './pluginMarketplace'
import { registerMarketplaceIpc } from './marketplaceIpc'
import {
  IPC,
  type MarketplaceProgressEvent,
  type PluginChangeEvent,
  type PluginSummary
} from '../shared/contract'

// Startup marks (docs/observability.md §6): module load → app ready → kernel
// spawn → window loaded. FLEXAGENT_PERF=1 prints `[perf] startup {…}`. The
// remaining cold-start cost (worker ESM graph + first attach) is reported by
// the worker's own perf traces.
const startup = perfStart()

const registry = new SessionRegistry()
const pluginRegistry = new PluginRegistry()
const kernel = new KernelHost()
let terminals: TerminalManager

function broadcastPluginsChanged(plugins: PluginSummary[]): void {
  const payload: PluginChangeEvent = { plugins }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.pluginsChanged, payload)
  }
}

function broadcastMarketplaceProgress(event: MarketplaceProgressEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.marketplaceProgress, event)
  }
}

function broadcastWindowMaximized(maximized: boolean): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.windowMaximized, maximized)
  }
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    frame: false,
    icon: join(__dirname, '../../resources/logo.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, '../preload/index.js')
    }
  })

  // Renderer hardening (security §Electron 边界).
  //
  // The window only ever shows FlexAgent's own renderer. Anything else — a link
  // in a chat message, an injected iframe target, a window.open from a plugin's
  // markdown — would replace the whole app with attacker-controlled content
  // that still sits behind the same preload bridge.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, target) => {
    const allowed = process.env.ELECTRON_RENDERER_URL
    const sameRenderer = allowed !== undefined && target.startsWith(allowed)
    if (!sameRenderer && !target.startsWith('file://')) event.preventDefault()
  })
  // DevTools are a debugging affordance for development builds only; in a
  // packaged app they are a one-click console on the IPC bridge.
  if (app.isPackaged) {
    mainWindow.webContents.on('devtools-opened', () => mainWindow.webContents.closeDevTools())
  }

  // Self-drawn min/max/close live in the renderer strip, so the maximize flag
  // has to be pushed on every transition (plus once after load for a window
  // restored into the maximized state).
  mainWindow.on('maximize', () => broadcastWindowMaximized(true))
  mainWindow.on('unmaximize', () => broadcastWindowMaximized(false))
  mainWindow.webContents.once('did-finish-load', () => {
    if (!mainWindow.isDestroyed()) broadcastWindowMaximized(mainWindow.isMaximized())
    startup.mark('window-loaded')
    startup.done('startup')
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // Frameless window: the menu bar would still render as a second strip above
  // the renderer's own titlebar, so the application menu is dropped entirely.
  Menu.setApplicationMenu(null)
  // The kernel worker `import()`s PI as an unbundled ESM graph, which costs
  // multiple seconds to parse and compile on every launch. Persist the V8
  // bytecode instead. Must run before the worker starts loading PI; the worker
  // picks the same directory up from the env var set below.
  try {
    enableCompileCache(join(app.getPath('userData'), 'compile-cache'))
    const cacheDir = getCompileCacheDir()
    if (cacheDir) process.env.FLEXAGENT_COMPILE_CACHE = cacheDir
  } catch {
    // Compile cache is a pure optimisation — never block startup on it.
  }
  registry.load()
  pluginRegistry.load()
  startup.mark('registries-loaded')
  kernel.start()
  startup.mark('kernel-started')
  // Prime the workspace the window is about to open (the most recently used
  // chat), falling back to scratch — which is where New chat lands. The worker
  // defers the expensive part until the UI stops sending requests, so this
  // never competes with what the user is doing.
  kernel.prewarm(registry.list()[0]?.cwd ?? scratchCwd())
  // Sole runState persistence path: kernel run_state events (fanOut in kernel.ts)
  // are the runtime authority; registry.runState is a pure projection (fix #6).
  kernel.setRunStateListener((sessionId, runState) => registry.setRunState(sessionId, runState))
  terminals = new TerminalManager(kernel, registry)
  const pluginService = new PluginService(pluginRegistry, kernel, () =>
    broadcastPluginsChanged(pluginService.list())
  )
  registerIpcHandlers(
    kernel,
    registry,
    terminals,
    pluginService,
    new UserMcpService(),
    new UserModelsService(),
    new KernelSettingsService()
  )
  const marketplaceService = new MarketplaceService({
    registry: pluginRegistry,
    storageRoot: pluginsStorageRoot(),
    notify: () => broadcastPluginsChanged(pluginService.list()),
    reloadKernel: () => pluginService.reloadKernel(),
    onProgress: broadcastMarketplaceProgress
  })
  registerMarketplaceIpc(marketplaceService)
  void pluginService.pushResourceSpec()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  event.preventDefault()
  void (async () => {
    try {
      terminals?.disposeAll()
      await kernel.shutdown()
    } finally {
      app.exit(0)
    }
  })()
})
