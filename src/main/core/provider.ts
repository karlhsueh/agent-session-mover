import type {
  AgentId,
  BlockedReason,
  ConflictReason,
  ImportWarning,
  PathMapping,
  SessionSummary,
} from '../../shared/sessions'
import type { FileRole, ManifestFile, ManifestSession, ManifestSource, Sha256 } from './manifest'
import type { StorePath } from './paths'
import type { TranscriptFile, TranscriptPreview } from './preview'
import type { ReadBudget } from './window'

export interface ProviderEnv {
  homeDir: string
  env: Readonly<Record<string, string | undefined>>
  platform: NodeJS.Platform
}

/** One file as export read it. `size` and `sha256` describe the snapshot, which may stop short of the file's end. */
export interface SnapshotFile extends ManifestFile {
  absPath: string
  /** Byte offset of the snapshot inside `absPath`, for a blob that is one record of a shared file. Defaults to 0. */
  start?: number
}

export interface CollectedSession {
  session: Omit<ManifestSession, 'files'>
  files: SnapshotFile[]
  live: boolean
}

/** Deterministic: the same input bytes always give the same output bytes, so preview and import agree. */
export type ContentTransform = (input: AsyncIterable<Buffer>) => AsyncIterable<Buffer>

export interface TargetFile {
  role: FileRole
  /** Computed by the provider from validated parts. Never a path copied from the archive. */
  path: StorePath
  /** The archive blob the bytes come from. */
  sha256: Sha256
  transform: ContentTransform | null
  mtimeMs: number
  /**
   * Where the existing copy lives when `path` is absent because the agent stores it in another form
   * (Codex compresses idle rollouts). `decode` turns that file into the bytes `path` would hold.
   * Import compares against the decoded bytes, and an update moves that file to the backup folder.
   */
  supersedes?: { path: StorePath; decode: ContentTransform }
}

/** Serializable and journaled before it runs, so a crash can undo it from the journal alone. */
export type ProviderEffect = { readonly [key: string]: JsonValue }
export type JsonValue = string | number | boolean | null | JsonValue[] | { readonly [key: string]: JsonValue }

export type RefusedAction =
  | { kind: 'conflict'; reason: ConflictReason; message: string }
  | { kind: 'blocked'; reason: BlockedReason; message: string }

export type TargetInspection =
  | {
      kind: 'ready'
      targetCwd: string | null
      warnings: ImportWarning[]
      live: boolean
      files: TargetFile[]
      /** Applied only when the plan writes something. */
      effects: ProviderEffect[]
    }
  | { kind: 'refused'; targetCwd: string | null; warnings: ImportWarning[]; action: RefusedAction }

/**
 * Runs `load` once per key and shares the result. Export and import preview share one across their
 * sessions, so a provider reads its store once per operation instead of once per session.
 */
export type ReadOnce = <T>(key: string, load: () => Promise<T>) => Promise<T>

/** Reads every time. Each import gets this, because the import before it changed the store. */
export const readFresh: ReadOnce = (_key, load) => load()

export function shareReads(): ReadOnce {
  const reads = new Map<string, Promise<unknown>>()
  return <T>(key: string, load: () => Promise<T>) => {
    if (!reads.has(key)) reads.set(key, load())
    return reads.get(key) as Promise<T>
  }
}

export interface ImportContext {
  env: ProviderEnv
  /** Store reads shared with the other sessions planned in the same pass. */
  once: ReadOnce
  source: ManifestSource
  /** Already validated, with each existing target resolved to its real path. */
  mappings: readonly PathMapping[]
  /** Path separator of this machine. */
  sep: string
  /** Streams a verified archive blob, for a provider that derives non-file effects from file content. */
  readBlob(sha256: Sha256): AsyncIterable<Buffer>
}

/** What a file looked like when facts were taken from it. A change in size or mtime means they are stale. */
export interface FileStamp {
  absPath: string
  size: number
  mtimeMs: number
}

/**
 * One listing pass as a provider sees it. Facts derived from a file are kept across passes and app
 * launches, keyed by the file's path, size, and mtime, so an unchanged file is not read again.
 */
export interface Scan {
  /** Names the files this pass takes `kind` facts from, so progress can count the ones it must read. */
  expect(kind: string, files: readonly FileStamp[]): void
  /**
   * `derive` reads the file, and runs only when no facts are kept for this exact stamp. `kind` names
   * what is derived, so one file can carry several. The facts must be plain JSON.
   */
  facts<T>(kind: string, file: FileStamp, derive: () => Promise<T>): Promise<T>
}

export interface Provider {
  readonly agent: AgentId
  /** Bump when what `discover` derives from a file changes, so facts kept from an older version are dropped. */
  readonly factsVersion: number
  /** Absolute store root on this machine. The store may not exist yet. */
  storeRoot(env: ProviderEnv): string
  /** Read-only. Without a scan, every file is read. */
  discover(root: string, env: ProviderEnv, scan?: Scan): Promise<SessionSummary[]>
  /** Read-only. Throws when the session is missing or ambiguous. */
  collect(root: string, id: string, env: ProviderEnv, once?: ReadOnce): Promise<CollectedSession>
  /** Read-only. Says where each archive file would land and what the provider refuses. */
  inspectTarget(root: string, session: ManifestSession, context: ImportContext): Promise<TargetInspection>
  /** The archive file role that holds a session's main transcript, the one its Conversation preview reads. */
  readonly transcriptRole: FileRole
  /** Shell line that resumes the session, `cd` included when the cwd is known. */
  resumeCommand(id: string, cwd: string | null): string
  /** Read-only. The session's main transcript on this machine, or null when the session is not here. */
  findTranscript(root: string, id: string, env: ProviderEnv): Promise<TranscriptFile | null>
  /** Read-only. One parser per agent turns a store file or a staged archive blob into the Conversation preview. */
  previewTranscript(file: TranscriptFile, budget?: ReadBudget): Promise<TranscriptPreview>
  applyEffect(root: string, effect: ProviderEffect): Promise<void>
  /** Must be safe when `applyEffect` never ran or only partly ran, and safe to call twice. */
  undoEffect(root: string, effect: ProviderEffect): Promise<void>
}

export type ProviderRegistry = Record<AgentId, Provider>
