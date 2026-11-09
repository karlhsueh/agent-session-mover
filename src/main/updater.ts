import { app, BrowserWindow, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'
import { CHANNELS, type UpdateStatus } from '../shared/ipc'

export type UpdaterEvent =
  | { type: 'available'; version: string }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error' }

export const IDLE: UpdateStatus = { kind: 'idle' }

export function nextStatus(status: UpdateStatus, event: UpdaterEvent): UpdateStatus {
  switch (event.type) {
    case 'available':
      return status.kind === 'ready' && status.version === event.version ? status : { kind: 'downloading', version: event.version, percent: 0 }
    case 'progress':
      return status.kind === 'downloading' ? { ...status, percent: Math.round(event.percent) } : status
    case 'downloaded':
      return { kind: 'ready', version: event.version }
    case 'error':
      // A failed later check does not remove the update already downloaded.
      return status.kind === 'ready' ? status : IDLE
  }
}

const FIRST_CHECK_MS = 5_000
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000

export interface Updater {
  /** False in an unpackaged build, which never checks. */
  enabled: boolean
  status(): UpdateStatus
  /** Starts the background checks. Call once the first window exists. */
  start(): void
  /** The menu's check, which reports its result in a dialog. */
  checkFromMenu(): Promise<void>
  install(): void
}

/**
 * `forcedVersion` comes from AGENT_SESSIONS_E2E_UPDATE in unpackaged builds only. It starts the
 * status at ready so a test can see the notice, and install then logs instead of quitting.
 */
export function createUpdater(options: { packaged: boolean; forcedVersion?: string }): Updater {
  let status: UpdateStatus = options.forcedVersion ? { kind: 'ready', version: options.forcedVersion } : IDLE
  const apply = (event: UpdaterEvent) => {
    const next = nextStatus(status, event)
    if (next === status) return
    status = next
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed()) window.webContents.send(CHANNELS.updateChanged, status)
    }
  }

  if (options.packaged) {
    autoUpdater.logger = console
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('update-available', (info) => apply({ type: 'available', version: info.version }))
    autoUpdater.on('download-progress', (progress) => apply({ type: 'progress', percent: progress.percent }))
    autoUpdater.on('update-downloaded', (info) => apply({ type: 'downloaded', version: info.version }))
    autoUpdater.on('error', (error) => {
      console.error('Update failed:', error)
      apply({ type: 'error' })
    })
  }

  const install = () => {
    if (status.kind !== 'ready') return
    if (!options.packaged) {
      console.log(`Would restart to install ${status.version}.`)
      return
    }
    autoUpdater.quitAndInstall()
  }

  const backgroundCheck = () => {
    if (status.kind === 'ready') return
    autoUpdater.checkForUpdates().catch((error: unknown) => console.error('Update check failed:', error))
  }

  return {
    enabled: options.packaged,
    status: () => status,
    install,
    start: () => {
      if (!options.packaged) return
      setTimeout(backgroundCheck, FIRST_CHECK_MS)
      setInterval(backgroundCheck, CHECK_EVERY_MS)
    },
    checkFromMenu: async () => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const show = (options: Electron.MessageBoxOptions) => (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options))
      if (status.kind === 'ready') {
        const { response } = await show({
          type: 'info',
          message: `Version ${status.version} is ready to install.`,
          detail: 'Agent Sessions will restart to finish the update.',
          buttons: ['Restart', 'Later'],
          defaultId: 0,
          cancelId: 1,
        })
        if (response === 0) install()
        return
      }
      try {
        const result = await autoUpdater.checkForUpdates()
        if (result?.isUpdateAvailable) {
          await show({ type: 'info', message: `Version ${result.updateInfo.version} is downloading.`, detail: 'Agent Sessions will offer to restart when it is ready.' })
        } else {
          await show({ type: 'info', message: `Agent Sessions ${app.getVersion()} is the newest version.` })
        }
      } catch (error) {
        console.error('Update check failed:', error)
        await show({ type: 'warning', message: 'Could not check for updates.', detail: error instanceof Error ? error.message : String(error) })
      }
    },
  }
}
