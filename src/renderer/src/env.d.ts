import type { DesktopApi } from '../../shared/ipc'

declare global {
  interface Window {
    api: DesktopApi
  }

  // Declared so App.tsx can probe them on globalThis. `unknown` keeps any real use,
  // such as `process.env`, a type error. Both are undefined at runtime.
  var process: unknown
  var require: unknown
}
