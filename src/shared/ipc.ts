export const GREET_CHANNEL = 'greet'

export type RuntimeInfo = {
  pid: number
  // string rather than NodeJS.Platform: naming that type here would pull Node's
  // globals into the renderer's type check, and `process.env` would then compile there.
  platform: string
  electron: string
  node: string
  chrome: string
}

export type GreetResult =
  | { ok: true; message: string; runtime: RuntimeInfo }
  | { ok: false; error: string }

export interface DesktopApi {
  greet(name: string): Promise<GreetResult>
}
