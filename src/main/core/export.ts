import path from 'node:path'
import type { AgentId, ExportResult, ProgressEvent, SessionKey } from '../../shared/sessions'
import { parseSessionKey } from '../../shared/sessions'
import { type BlobSource, writeArchive } from '../archive/archive'
import { MANIFEST_FORMAT, MANIFEST_VERSION, type Manifest, type ManifestSession, type Sha256 } from './manifest'
import { type ProviderEnv, type ProviderRegistry, shareReads } from './provider'

export interface CoreContext {
  providers: ProviderRegistry
  env: ProviderEnv
  /** Holds journals, backups, and staged archives. Electron passes `app.getPath('userData')`. */
  appDataDir: string
  appVersion: string
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
  const once = shareReads()
  for (const [index, key] of keys.entries()) {
    onProgress?.({ operation: 'export', phase: 'read', current: index + 1, total: keys.length })
    const parsed = parseSessionKey(key)
    if (!parsed) throw new Error(`Not a session key: ${key}`)
    const provider = context.providers[parsed.agent]
    const root = provider.storeRoot(context.env)
    storeRoots[parsed.agent] = root
    const collected = await provider.collect(root, parsed.id, context.env, once)
    if (collected.live) liveKeys.push(parsed.key)
    sessions.push({
      ...collected.session,
      files: collected.files.map(({ absPath: _absPath, start: _start, ...file }) => file),
    })
    for (const file of collected.files) {
      if (!blobs.has(file.sha256)) blobs.set(file.sha256, file)
    }
  }

  const manifest: Manifest = {
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    appVersion: context.appVersion,
    source: { platform: context.env.platform, homeDir: context.env.homeDir, sep: path.sep === '\\' ? '\\' : '/', storeRoots },
    sessions,
  }
  const bytes = await writeArchive(destPath, manifest, blobs, (bytesDone, bytesTotal) =>
    onProgress?.({ operation: 'export', phase: 'write', bytesDone, bytesTotal }),
  )
  return {
    filePath: destPath,
    sessionCount: sessions.length,
    fileCount: sessions.reduce((sum, session) => sum + session.files.length, 0),
    bytes,
    liveKeys,
  }
}
