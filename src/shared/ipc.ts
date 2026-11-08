import type {
  ArchiveSummary,
  ArchiveToken,
  ExportResult,
  ImportPreview,
  ImportResult,
  PathMapping,
  ProgressEvent,
  SessionKey,
  SessionList,
} from './sessions'

export const GREET_CHANNEL = 'greet'

export const CHANNELS = {
  listSessions: 'sessions:list',
  exportSessions: 'sessions:export',
  openArchive: 'archive:open',
  previewImport: 'import:preview',
  runImport: 'import:run',
  progress: 'progress',
} as const

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

export type ApiErrorCode =
  | 'invalid-input'
  | 'unknown-archive'
  | 'invalid-archive'
  | 'busy'
  | 'io'

export interface ApiError {
  code: ApiErrorCode
  message: string
}

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiError }

/** A dialog the user closed without choosing a file. */
export type Cancelled = { kind: 'cancelled' }

export type ExportOutcome = Cancelled | ({ kind: 'saved' } & ExportResult)

export type OpenArchiveOutcome =
  | Cancelled
  | { kind: 'opened'; token: ArchiveToken; archive: ArchiveSummary; suggestedMappings: PathMapping[] }

/**
 * The renderer never sends a file path. Main shows the save and open dialogs itself and hands back
 * an opaque archive token. Session keys and mappings are checked in main before use.
 */
export interface DesktopApi {
  greet(name: string): Promise<GreetResult>
  listSessions(): Promise<ApiResult<SessionList>>
  exportSessions(keys: SessionKey[]): Promise<ApiResult<ExportOutcome>>
  openArchive(): Promise<ApiResult<OpenArchiveOutcome>>
  previewImport(token: ArchiveToken, mappings: PathMapping[]): Promise<ApiResult<ImportPreview>>
  runImport(token: ArchiveToken, mappings: PathMapping[], keys: SessionKey[]): Promise<ApiResult<ImportResult>>
  /** Returns the unsubscribe function. */
  onProgress(callback: (event: ProgressEvent) => void): () => void
}
