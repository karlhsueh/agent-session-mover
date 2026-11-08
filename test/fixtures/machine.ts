import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { CoreContext } from '../../src/main/core/export'
import { providers } from '../../src/main/providers/registry'
import { makeTempDir } from './claude-store'

export interface Machine {
  dir: string
  home: string
  /** The Claude Code store root, `<home>/.claude`. */
  root: string
  appData: string
  context: CoreContext
}

/** A fake computer: its own home, Claude store, and app data folder under one temp dir. */
export async function makeMachine(label: string): Promise<Machine> {
  const dir = await makeTempDir(label)
  const home = path.join(dir, 'home')
  const appData = path.join(dir, 'appdata')
  await mkdir(home, { recursive: true })
  return {
    dir,
    home,
    root: path.join(home, '.claude'),
    appData,
    context: { providers, env: { homeDir: home, env: {}, platform: process.platform }, appDataDir: appData, appVersion: '0.0.0-test' },
  }
}
