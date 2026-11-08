import type {
  AgentId,
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

export const CHANNELS = {
  listSessions: 'sessions:list',
  exportSessions: 'sessions:export',
  openArchive: 'archive:open',
  previewImport: 'import:preview',
  runImport: 'import:run',
  progress: 'progress',
  storeRoots: 'stores:roots',
  chooseFolder: 'dialog:folder',
  revealExport: 'export:reveal',
  copyText: 'clipboard:write',
} as const

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
  listSessions(): Promise<ApiResult<SessionList>>
  exportSessions(keys: SessionKey[]): Promise<ApiResult<ExportOutcome>>
  openArchive(): Promise<ApiResult<OpenArchiveOutcome>>
  previewImport(token: ArchiveToken, mappings: PathMapping[]): Promise<ApiResult<ImportPreview>>
  runImport(token: ArchiveToken, mappings: PathMapping[], keys: SessionKey[]): Promise<ApiResult<ImportResult>>
  /** Returns the unsubscribe function. */
  onProgress(callback: (event: ProgressEvent) => void): () => void
  /** The store folder each provider reads on this machine. */
  storeRoots(): Promise<StoreRoot[]>
  /** Shows the folder picker. Returns the chosen folder, or null when the user closed it. */
  chooseFolder(startIn: string | null): Promise<string | null>
  /** Shows the archive this window saved last in Finder or Explorer. */
  revealExport(): Promise<void>
  copyText(text: string): Promise<void>
}

export interface StoreRoot {
  agent: AgentId
  path: string
}
