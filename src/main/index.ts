import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron'
import { CHANNELS, type StoreRoot } from '../shared/ipc'
import type { AgentId, ProgressEvent } from '../shared/sessions'
import { ARCHIVE_EXTENSION } from './archive/archive'
import { recoverJournals } from './core/executor'
import type { CoreContext } from './core/export'
import { clearStaging } from './core/import'
import { providers } from './providers/registry'
import { createSessionService, type SessionService } from './service'
import { createUpdater, type Updater } from './updater'

// Playwright cannot drive native dialogs. e2e/smoke.mts names the files and folders they would
// return, and a separate userData folder so a test run never touches real backups or journals.
const e2e = app.isPackaged
  ? {}
  : {
      savePath: process.env.AGENT_SESSIONS_E2E_SAVE_PATH,
      openPath: process.env.AGENT_SESSIONS_E2E_OPEN_PATH,
      folderPath: process.env.AGENT_SESSIONS_E2E_FOLDER_PATH,
      userData: process.env.AGENT_SESSIONS_E2E_USER_DATA,
      // `claude-code:100,codex:300` waits that long after each file a listing reads, so a test can watch the scan.
      scanPace: process.env.AGENT_SESSIONS_E2E_SCAN_PACE,
      // `0.9.9` starts the update status at available for that version, so a test can see the update notice.
      update: process.env.AGENT_SESSIONS_E2E_UPDATE,
    }
const APP_NAME = 'Agent Session Mover'
// Journals and backups live in userData, and its default folder follows the app name. Pinning it
// keeps an unfinished import recoverable across the rename and between dev and packaged builds.
app.setPath('userData', join(app.getPath('appData'), 'agent-sessions'))
app.setName(APP_NAME)
app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: app.getVersion() })
if (e2e.userData) app.setPath('userData', e2e.userData)

function scanPace(spec: string | undefined): ((agent: AgentId) => Promise<void>) | undefined {
  if (!spec) return undefined
  const delays = new Map(spec.split(',').map((part) => [part.split(':')[0], Number(part.split(':')[1])]))
  return async (agent) => {
    const ms = delays.get(agent)
    if (ms) await new Promise((resolve) => setTimeout(resolve, ms))
  }
}

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

  // A packaged app ignores the dev server variable, so the environment cannot point it at another page.
  const devServerUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
  if (devServerUrl) {
    window.loadURL(devServerUrl)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * Electron's default menu, without its View > Reload. That item takes Cmd/Ctrl+R, which would reload
 * the page and drop the selection. The window uses the key to look for new sessions instead. The macOS
 * app menu is spelled out so Check for Updates can sit under About.
 */
function setMenu(updater: Updater): void {
  const checkForUpdates: MenuItemConstructorOptions[] = updater.enabled ? [{ label: 'Check for Updates…', click: () => void updater.checkFromMenu() }] : []
  const mac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: APP_NAME,
            submenu: [
              { role: 'about' as const },
              ...checkForUpdates,
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    ...(!mac && checkForUpdates.length > 0 ? [{ role: 'help' as const, submenu: checkForUpdates }] : []),
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

const archiveFilter = { name: 'Agent Session Mover archive', extensions: [ARCHIVE_EXTENSION] }

function registerSessionHandlers(service: SessionService): void {
  const emitter = (event: IpcMainInvokeEvent) => (progress: ProgressEvent) => {
    if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.progress, progress)
  }
  const owner = (event: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(event.sender)
  let lastExport: string | null = null
  let lastBackups: string | null = null

  ipcMain.handle(CHANNELS.listSessions, (event, agent: unknown) => service.listSessions(agent, emitter(event)))
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
  ipcMain.handle(CHANNELS.runImport, async (event, token: unknown, mappings: unknown, requests: unknown) => {
    const result = await service.runImport(token, mappings, requests, emitter(event))
    if (result.ok) lastBackups = result.value.backupDir
    return result
  })
  ipcMain.handle(CHANNELS.createFolder, (_event, token: unknown, target: unknown) => service.createFolder(token, target))
  ipcMain.handle(CHANNELS.revealExport, () => {
    if (lastExport) shell.showItemInFolder(lastExport)
  })
  ipcMain.handle(CHANNELS.revealBackups, () => {
    if (lastBackups) shell.showItemInFolder(lastBackups)
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
  const service = createSessionService(context, { pace: scanPace(e2e.scanPace) })
  app.on('will-quit', () => void service.dispose())

  registerSessionHandlers(service)
  registerShellHandlers(context)
  const updater = createUpdater({ packaged: app.isPackaged, forcedVersion: e2e.update, busy: service.busy })
  ipcMain.handle(CHANNELS.updateStatus, () => updater.status())
  ipcMain.handle(CHANNELS.downloadUpdate, () => updater.download())
  ipcMain.handle(CHANNELS.installUpdate, () => updater.install())
  setMenu(updater)
  createWindow()
  updater.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
