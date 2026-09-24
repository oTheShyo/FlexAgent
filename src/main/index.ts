import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { registerIpcHandlers } from './ipc'
import { KernelHost } from './kernel'
import { SessionRegistry } from './registry'
import { TerminalManager } from './pty'
import { PluginRegistry, pluginsStorageRoot } from './pluginRegistry'
import { PluginService } from './plugins'
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
  registry.load()
  pluginRegistry.load()
  kernel.start()
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
