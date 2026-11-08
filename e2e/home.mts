import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

// Windows resolves the app data folders from %USERPROFILE%, so a fake home needs them or Electron cannot start.
export async function homeEnv(home: string): Promise<Record<string, string>> {
  const roaming = join(home, 'AppData', 'Roaming')
  const local = join(home, 'AppData', 'Local')
  await mkdir(roaming, { recursive: true })
  await mkdir(local, { recursive: true })
  return { HOME: home, USERPROFILE: home, APPDATA: roaming, LOCALAPPDATA: local }
}
