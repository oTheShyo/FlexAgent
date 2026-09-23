import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { registerIpcHandlers } from './ipc'
import { KernelHost } from './kernel'
import { SessionRegistry } from './registry'
import { TerminalManager } from './pty'

const registry = new SessionRegistry()
const kernel = new KernelHost()
let terminals: TerminalManager

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
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
  kernel.start()
  kernel.setRunStateListener((sessionId, runState) => registry.setRunState(sessionId, runState))
  terminals = new TerminalManager(kernel, registry)
  registerIpcHandlers(kernel, registry, terminals)
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
