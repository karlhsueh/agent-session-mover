import path from 'node:path'
import type { AgentId, ExportResult, ProgressEvent, SessionKey, SessionList } from '../../shared/sessions'
import { parseSessionKey } from '../../shared/sessions'
import { type BlobSource, writeArchive } from '../archive/archive'
import { MANIFEST_FORMAT, MANIFEST_VERSION, type Manifest, type ManifestSession, type Sha256 } from './manifest'
import type { ProviderEnv, ProviderRegistry } from './provider'

export interface CoreContext {
  providers: ProviderRegistry
  env: ProviderEnv
  /** Holds journals, backups, and staged archives. Electron passes `app.getPath('userData')`. */
  appDataDir: string
  appVersion: string
}

export async function listSessions(context: CoreContext): Promise<SessionList> {
  const list: SessionList = { sessions: [], problems: [] }
  for (const provider of Object.values(context.providers)) {
    try {
      list.sessions.push(...(await provider.discover(provider.storeRoot(context.env))))
    } catch (error) {
      list.problems.push({ agent: provider.agent, message: error instanceof Error ? error.message : String(error) })
    }
  }
  list.sessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
  return list
}

/** Reads each session's snapshot and writes one archive. Source stores are only read. */
export async function exportSessions(
  context: CoreContext,
  keys: readonly SessionKey[],
  destPath: string,
  onProgress?: (event: ProgressEvent) => void,
): Promise<ExportResult> {
  const sessions: ManifestSession[] = []
  const blobs = new Map<Sha256, BlobSource>()
  const storeRoots: Partial<Record<AgentId, string>> = {}
  const liveKeys: SessionKey[] = []
  for (const [index, key] of keys.entries()) {
    const parsed = parseSessionKey(key)
    if (!parsed) throw new Error(`Not a session key: ${key}`)
    const provider = context.providers[parsed.agent]
    if (!provider) throw new Error(`No provider for ${parsed.agent}`)
    const root = provider.storeRoot(context.env)
    storeRoots[parsed.agent] = root
    const collected = await provider.collect(root, parsed.id)
    if (collected.live) liveKeys.push(parsed.key)
    sessions.push({
      ...collected.session,
      files: collected.files.map(({ absPath: _absPath, ...file }) => file),
    })
    for (const file of collected.files) {
      if (!blobs.has(file.sha256)) blobs.set(file.sha256, file)
    }
    onProgress?.({ operation: 'export', done: index + 1, total: keys.length })
  }

  const manifest: Manifest = {
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    appVersion: context.appVersion,
    source: { platform: context.env.platform, homeDir: context.env.homeDir, sep: path.sep === '\\' ? '\\' : '/', storeRoots },
    sessions,
  }
  const bytes = await writeArchive(destPath, manifest, blobs)
  return {
    filePath: destPath,
    sessionCount: sessions.length,
    fileCount: sessions.reduce((sum, session) => sum + session.files.length, 0),
    bytes,
    liveKeys,
  }
}
