import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { CHANNELS } from '../shared/ipc'
import type { ProgressEvent } from '../shared/sessions'
import { ARCHIVE_EXTENSION } from './archive/archive'
import { recoverJournals } from './core/executor'
import type { CoreContext } from './core/export'
import { clearStaging } from './core/import'
import { providers } from './providers/registry'
import { createSessionService, type SessionService } from './service'

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

const archiveFilter = { name: 'Agent Sessions archive', extensions: [ARCHIVE_EXTENSION] }

function registerSessionHandlers(service: SessionService): void {
  const emitter = (event: IpcMainInvokeEvent) => (progress: ProgressEvent) => {
    if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.progress, progress)
  }
  const owner = (event: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(event.sender)

  ipcMain.handle(CHANNELS.listSessions, () => service.listSessions())
  ipcMain.handle(CHANNELS.exportSessions, (event, keys: unknown) =>
    service.exportSessions(
      keys,
      async () => {
        const options = { defaultPath: `sessions.${ARCHIVE_EXTENSION}`, filters: [archiveFilter] }
        const window = owner(event)
        const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
        if (result.canceled || !result.filePath) return null
        return result.filePath.endsWith(`.${ARCHIVE_EXTENSION}`) ? result.filePath : `${result.filePath}.${ARCHIVE_EXTENSION}`
      },
      emitter(event),
    ),
  )
  ipcMain.handle(CHANNELS.openArchive, (event) =>
    service.openArchive(async () => {
      const options = { properties: ['openFile' as const], filters: [archiveFilter] }
      const window = owner(event)
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      return result.canceled ? null : (result.filePaths[0] ?? null)
    }, emitter(event)),
  )
  ipcMain.handle(CHANNELS.previewImport, (_event, token: unknown, mappings: unknown) => service.previewImport(token, mappings))
  ipcMain.handle(CHANNELS.runImport, (event, token: unknown, mappings: unknown, keys: unknown) =>
    service.runImport(token, mappings, keys, emitter(event)),
  )
}

app.whenReady().then(async () => {
  const context: CoreContext = {
    providers,
    env: { homeDir: homedir(), env: process.env, platform: process.platform },
    appDataDir: app.getPath('userData'),
    appVersion: app.getVersion(),
  }
  // An import that never committed is rolled back before any new work can start.
  for (const result of await recoverJournals(join(context.appDataDir, 'journal'), providers)) {
    if (!result.ok) console.error(`Could not roll back ${result.file}: ${result.errors.join('; ')}`)
  }
  await clearStaging(context.appDataDir)
  const service = createSessionService(context)
  app.on('will-quit', () => void service.dispose())

  registerSessionHandlers(service)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
