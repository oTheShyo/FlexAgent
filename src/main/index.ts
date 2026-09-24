import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { enableCompileCache, getCompileCacheDir } from 'node:module'
import { registerIpcHandlers } from './ipc'
import { KernelHost } from './kernel'
import { SessionRegistry } from './registry'
import { TerminalManager } from './pty'
import { PluginRegistry, pluginsStorageRoot } from './pluginRegistry'
import { PluginService } from './plugins'
import { scratchCwd } from './workspace'
import { MarketplaceService } from './pluginMarketplace'
import { registerMarketplaceIpc } from './marketplaceIpc'
import {
  IPC,
  type MarketplaceProgressEvent,
  type PluginChangeEvent,
  type PluginSummary
} from '../shared/contract'

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

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    icon: join(__dirname, '../../resources/logo.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, '../preload/index.js')
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
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
  kernel.start()
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
  registerIpcHandlers(kernel, registry, terminals, pluginService)
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
