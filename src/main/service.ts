import { ArchiveError } from './archive/archive'
import { TarError } from './archive/tar'
import { createDiscovery, listSessions } from './core/discovery'
import { exportSessions, type CoreContext } from './core/export'
import {
  closeArchive,
  defaultExists,
  openArchive,
  type OpenedArchive,
  previewImport,
  runImport,
  type RunImportOptions,
  suggestMappings,
  summarizeArchive,
} from './core/import'
import { ManifestError } from './core/manifest'
import { previewArchivedSession, previewStoredSession } from './core/preview-session'
import type { ArchiveLimits } from './archive/archive'
import { InputError, parseKey, parseKeys, parseMappings, parseToken } from './ipc-input'
import type { ApiError, ApiResult, ExportOutcome, OpenArchiveOutcome } from '../shared/ipc'
import type { ArchiveToken, ImportPreview, ImportResult, ProgressEvent, SessionList, SessionPreview } from '../shared/sessions'
import path from 'node:path'

export type Emit = (event: ProgressEvent) => void

/** What the IPC handlers call. Takes untrusted input, and dialogs as functions so tests can drive it without Electron. */
export interface SessionService {
  listSessions(): Promise<ApiResult<SessionList>>
  previewSession(key: unknown): Promise<ApiResult<SessionPreview>>
  previewArchiveSession(token: unknown, key: unknown): Promise<ApiResult<SessionPreview>>
  exportSessions(keys: unknown, chooseDestination: () => Promise<string | null>, emit: Emit): Promise<ApiResult<ExportOutcome>>
  openArchive(chooseArchive: () => Promise<string | null>, emit: Emit): Promise<ApiResult<OpenArchiveOutcome>>
  previewImport(token: unknown, mappings: unknown): Promise<ApiResult<ImportPreview>>
  runImport(token: unknown, mappings: unknown, keys: unknown, emit: Emit): Promise<ApiResult<ImportResult>>
  dispose(): Promise<void>
}

export function createSessionService(
  context: CoreContext,
  options: { limits?: ArchiveLimits; fault?: RunImportOptions['fault'] } = {},
): SessionService {
  // One archive is open at a time. Opening another closes the previous one and its token stops working.
  let current: OpenedArchive | null = null
  let busy = false
  // Kept for the app's lifetime, so a refresh reads only files that changed since the last pass.
  const discovery = createDiscovery(context)

  // Previews only read, so they run beside an export or import instead of waiting for the lock.
  async function attempt<T>(work: () => Promise<T>): Promise<ApiResult<T>> {
    try {
      return { ok: true, value: await work() }
    } catch (error) {
      return { ok: false, error: toApiError(error) }
    }
  }

  async function exclusive<T>(work: () => Promise<T>): Promise<ApiResult<T>> {
    if (busy) return { ok: false, error: { code: 'busy', message: 'Another export or import is still running.' } }
    busy = true
    try {
      return { ok: true, value: await work() }
    } catch (error) {
      return { ok: false, error: toApiError(error) }
    } finally {
      busy = false
    }
  }

  function archiveFor(token: ArchiveToken): OpenedArchive {
    if (!current || current.token !== token) throw new UnknownArchive()
    return current
  }

  return {
    listSessions() {
      return attempt(() => listSessions(context, discovery))
    },

    previewSession(keyInput) {
      return attempt(() => {
        const { agent, id } = parseKey(keyInput)
        return previewStoredSession(context, agent, id)
      })
    },

    previewArchiveSession(tokenInput, keyInput) {
      return attempt(async () => {
        const opened = archiveFor(parseToken(tokenInput))
        const { key } = parseKey(keyInput)
        const preview = await previewArchivedSession(context, opened, key)
        if (!preview) throw new InputError(`The archive has no session ${key}.`)
        return preview
      })
    },

    exportSessions(keysInput, chooseDestination, emit) {
      return exclusive(async () => {
        const keys = parseKeys(keysInput)
        const destination = await chooseDestination()
        if (!destination) return { kind: 'cancelled' as const }
        return { kind: 'saved' as const, ...(await exportSessions(context, keys, destination, emit)) }
      })
    },

    openArchive(chooseArchive, emit) {
      return exclusive(async () => {
        const archivePath = await chooseArchive()
        if (!archivePath) return { kind: 'cancelled' as const }
        const opened = await openArchive(context, archivePath, { limits: options.limits, onProgress: emit })
        if (current) await closeArchive(current)
        current = opened
        return {
          kind: 'opened' as const,
          token: opened.token,
          archive: summarizeArchive(opened),
          suggestedMappings: suggestMappings(opened.manifest, { homeDir: context.env.homeDir, sep: path.sep, exists: defaultExists }),
        }
      })
    },

    previewImport(tokenInput, mappingsInput) {
      return exclusive(async () => {
        const opened = archiveFor(parseToken(tokenInput))
        return previewImport(context, opened, parseMappings(mappingsInput))
      })
    },

    runImport(tokenInput, mappingsInput, keysInput, emit) {
      return exclusive(async () => {
        const opened = archiveFor(parseToken(tokenInput))
        const mappings = parseMappings(mappingsInput)
        const keys = parseKeys(keysInput)
        const archived = new Set(opened.manifest.sessions.map((session) => `${session.agent}:${session.id}`))
        const missing = keys.find((key) => !archived.has(key))
        if (missing) throw new InputError(`The archive has no session ${missing}.`)
        return runImport(context, opened, mappings, keys, { fault: options.fault, onProgress: emit })
      })
    },

    async dispose() {
      if (current) await closeArchive(current)
      current = null
    },
  }
}

class UnknownArchive extends Error {
  constructor() {
    super('That archive is no longer open. Open it again.')
  }
}

function toApiError(error: unknown): ApiError {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof InputError) return { code: 'invalid-input', message }
  if (error instanceof UnknownArchive) return { code: 'unknown-archive', message }
  if (error instanceof ArchiveError || error instanceof ManifestError || error instanceof TarError) return { code: 'invalid-archive', message }
  return { code: 'io', message }
}
