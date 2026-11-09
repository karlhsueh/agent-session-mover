import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CHANNELS, type DesktopApi, type UpdateStatus } from '../shared/ipc'
import type { ProgressEvent } from '../shared/sessions'

const api: DesktopApi = {
  listSessions: (agent) => ipcRenderer.invoke(CHANNELS.listSessions, agent),
  previewSession: (key) => ipcRenderer.invoke(CHANNELS.previewSession, key),
  exportSessions: (keys) => ipcRenderer.invoke(CHANNELS.exportSessions, keys),
  openArchive: () => ipcRenderer.invoke(CHANNELS.openArchive),
  previewImport: (token, mappings) => ipcRenderer.invoke(CHANNELS.previewImport, token, mappings),
  previewArchiveSession: (token, key) => ipcRenderer.invoke(CHANNELS.previewArchiveSession, token, key),
  runImport: (token, mappings, keys) => ipcRenderer.invoke(CHANNELS.runImport, token, mappings, keys),
  createFolder: (token, target) => ipcRenderer.invoke(CHANNELS.createFolder, token, target),
  onProgress: (callback) => {
    const listener = (_event: IpcRendererEvent, progress: ProgressEvent) => callback(progress)
    ipcRenderer.on(CHANNELS.progress, listener)
    return () => {
      ipcRenderer.removeListener(CHANNELS.progress, listener)
    }
  },
  storeRoots: () => ipcRenderer.invoke(CHANNELS.storeRoots),
  chooseFolder: (startIn) => ipcRenderer.invoke(CHANNELS.chooseFolder, startIn),
  revealExport: () => ipcRenderer.invoke(CHANNELS.revealExport),
  revealBackups: () => ipcRenderer.invoke(CHANNELS.revealBackups),
  copyText: (text) => ipcRenderer.invoke(CHANNELS.copyText, text),
  homeDir: () => ipcRenderer.invoke(CHANNELS.homeDir),
  onUpdateStatus: (callback) => {
    const listener = (_event: IpcRendererEvent, status: UpdateStatus) => callback(status)
    ipcRenderer.on(CHANNELS.updateChanged, listener)
    return () => {
      ipcRenderer.removeListener(CHANNELS.updateChanged, listener)
    }
  },
  updateStatus: () => ipcRenderer.invoke(CHANNELS.updateStatus),
  installUpdate: () => ipcRenderer.invoke(CHANNELS.installUpdate),
}

contextBridge.exposeInMainWorld('api', api)
