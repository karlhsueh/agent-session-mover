import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { CHANNELS, type StoreRoot } from '../shared/ipc'
import type { ProgressEvent } from '../shared/sessions'
import { ARCHIVE_EXTENSION } from './archive/archive'
import { recoverJournals } from './core/executor'
import type { CoreContext } from './core/export'
import { clearStaging } from './core/import'
import { providers } from './providers/registry'
import { createSessionService, type SessionService } from './service'

// Playwright cannot drive native dialogs. e2e/smoke.mts names the files and folders they would
// return, and a separate userData folder so a test run never touches real backups or journals.
const e2e = app.isPackaged
  ? {}
  : {
      savePath: process.env.AGENT_SESSIONS_E2E_SAVE_PATH,
      openPath: process.env.AGENT_SESSIONS_E2E_OPEN_PATH,
      folderPath: process.env.AGENT_SESSIONS_E2E_FOLDER_PATH,
      userData: process.env.AGENT_SESSIONS_E2E_USER_DATA,
    }
const APP_NAME = 'Agent Sessions'
// Journals and backups live in userData, and its default folder follows the app name. Pinning it
// keeps an unfinished import recoverable across the rename and between dev and packaged builds.
app.setPath('userData', join(app.getPath('appData'), 'agent-sessions'))
app.setName(APP_NAME)
app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: app.getVersion() })
if (e2e.userData) app.setPath('userData', e2e.userData)

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: '#111214',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 15 } } : {}),
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
  let lastExport: string | null = null

  ipcMain.handle(CHANNELS.listSessions, () => service.listSessions())
  ipcMain.handle(CHANNELS.previewSession, (_event, key: unknown) => service.previewSession(key))
  ipcMain.handle(CHANNELS.exportSessions, async (event, keys: unknown) => {
    const result = await service.exportSessions(
      keys,
      async () => {
        if (e2e.savePath) return e2e.savePath
        const options = { defaultPath: `sessions.${ARCHIVE_EXTENSION}`, filters: [archiveFilter] }
        const window = owner(event)
        const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
        if (result.canceled || !result.filePath) return null
        return result.filePath.endsWith(`.${ARCHIVE_EXTENSION}`) ? result.filePath : `${result.filePath}.${ARCHIVE_EXTENSION}`
      },
      emitter(event),
    )
    if (result.ok && result.value.kind === 'saved') lastExport = result.value.filePath
    return result
  })
  ipcMain.handle(CHANNELS.openArchive, (event) =>
    service.openArchive(async () => {
      if (e2e.openPath) return e2e.openPath
      const options = { properties: ['openFile' as const], filters: [archiveFilter] }
      const window = owner(event)
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      return result.canceled ? null : (result.filePaths[0] ?? null)
    }, emitter(event)),
  )
  ipcMain.handle(CHANNELS.previewImport, (_event, token: unknown, mappings: unknown) => service.previewImport(token, mappings))
  ipcMain.handle(CHANNELS.previewArchiveSession, (_event, token: unknown, key: unknown) => service.previewArchiveSession(token, key))
  ipcMain.handle(CHANNELS.runImport, (event, token: unknown, mappings: unknown, keys: unknown) =>
    service.runImport(token, mappings, keys, emitter(event)),
  )
  ipcMain.handle(CHANNELS.revealExport, () => {
    if (lastExport) shell.showItemInFolder(lastExport)
  })
}

function registerShellHandlers(context: CoreContext): void {
  ipcMain.handle(CHANNELS.storeRoots, (): StoreRoot[] =>
    Object.values(context.providers).map((provider) => ({ agent: provider.agent, path: provider.storeRoot(context.env) })),
  )
  ipcMain.handle(CHANNELS.chooseFolder, async (event, startIn: unknown) => {
    if (e2e.folderPath) return e2e.folderPath
    const options = {
      properties: ['openDirectory' as const, 'createDirectory' as const],
      defaultPath: typeof startIn === 'string' && isAbsolute(startIn) ? startIn : context.env.homeDir,
    }
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(CHANNELS.homeDir, () => context.env.homeDir)
  ipcMain.handle(CHANNELS.copyText, (_event, text: unknown) => {
    if (typeof text === 'string' && text.length <= 64 * 1024) clipboard.writeText(text)
  })
}

app.whenReady().then(async () => {
  // A packaged app takes its icon from the bundle. `pnpm dev` runs Electron's own app, so set it here.
  if (!app.isPackaged && process.platform === 'darwin') app.dock?.setIcon(join(__dirname, '../../build/icon.png'))
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
  registerShellHandlers(context)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
