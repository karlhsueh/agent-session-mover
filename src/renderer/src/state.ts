import type { ApiError } from '../../shared/ipc'
import type { ArchiveSummary, ArchiveToken, ExportResult, ImportPreview, ImportResult, PathMapping, SessionKey } from '../../shared/sessions'

export type Loadable<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'failed'; error: ApiError }

export interface OpenedArchive {
  token: ArchiveToken
  summary: ArchiveSummary
}

/** A re-run keeps the last preview on screen so the rows do not jump while main plans again. */
export type PreviewState =
  | { status: 'loading'; last: ImportPreview | null }
  | { status: 'ready'; value: ImportPreview }
  | { status: 'failed'; error: ApiError; last: ImportPreview | null }

export interface PreviewScreen {
  kind: 'import-preview'
  archive: OpenedArchive
  mappings: PathMapping[]
  preview: PreviewState
  /** Sessions the user unticked. Every other actionable session imports. */
  excluded: ReadonlySet<SessionKey>
  error: ApiError | null
}

export type Screen =
  | { kind: 'browse'; error: ApiError | null }
  | { kind: 'export-confirm'; keys: SessionKey[]; error: ApiError | null }
  | { kind: 'exporting'; keys: SessionKey[] }
  | { kind: 'export-done'; result: ExportResult }
  | { kind: 'opening' }
  | PreviewScreen
  | { kind: 'importing'; from: PreviewScreen; keys: SessionKey[] }
  | { kind: 'import-done'; archive: OpenedArchive; result: ImportResult }

export function shownPreview(state: PreviewState): ImportPreview | null {
  return state.status === 'ready' ? state.value : state.last
}
