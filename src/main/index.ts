import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { GREET_CHANNEL, type GreetResult } from '../shared/ipc'

function greet(input: unknown): GreetResult {
  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: false, error: 'Name must be a non-blank string.' }
  }

  return {
    ok: true,
    message: `Hello, ${input.trim()}!`,
    runtime: {
      pid: process.pid,
      platform: process.platform,
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
    },
  }
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 760,
    minHeight: 520,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (devServerUrl) {
    window.loadURL(devServerUrl)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  ipcMain.handle(GREET_CHANNEL, (_event, input: unknown) => greet(input))
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
