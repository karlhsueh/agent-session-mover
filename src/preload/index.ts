import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CHANNELS, GREET_CHANNEL, type DesktopApi } from '../shared/ipc'
import type { ProgressEvent } from '../shared/sessions'

const api: DesktopApi = {
  greet: (name) => ipcRenderer.invoke(GREET_CHANNEL, name),
  listSessions: () => ipcRenderer.invoke(CHANNELS.listSessions),
  exportSessions: (keys) => ipcRenderer.invoke(CHANNELS.exportSessions, keys),
  openArchive: () => ipcRenderer.invoke(CHANNELS.openArchive),
  previewImport: (token, mappings) => ipcRenderer.invoke(CHANNELS.previewImport, token, mappings),
  runImport: (token, mappings, keys) => ipcRenderer.invoke(CHANNELS.runImport, token, mappings, keys),
  onProgress: (callback) => {
    const listener = (_event: IpcRendererEvent, progress: ProgressEvent) => callback(progress)
    ipcRenderer.on(CHANNELS.progress, listener)
    return () => {
      ipcRenderer.removeListener(CHANNELS.progress, listener)
    }
  },
}

contextBridge.exposeInMainWorld('api', api)
