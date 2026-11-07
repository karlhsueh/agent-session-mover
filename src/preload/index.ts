import { contextBridge, ipcRenderer } from 'electron'
import { GREET_CHANNEL, type DesktopApi } from '../shared/ipc'

const api: DesktopApi = {
  greet: (name) => ipcRenderer.invoke(GREET_CHANNEL, name),
}

contextBridge.exposeInMainWorld('api', api)
