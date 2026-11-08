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

export interface ProviderEnv {
  homeDir: string
  env: Readonly<Record<string, string | undefined>>
  platform: NodeJS.Platform
}

/** One file as export read it. `size` and `sha256` describe the snapshot, which may stop short of the file's end. */
export interface SnapshotFile extends ManifestFile {
  absPath: string
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

export interface ImportContext {
  source: ManifestSource
  /** Already validated, with each existing target resolved to its real path. */
  mappings: readonly PathMapping[]
  /** Path separator of this machine. */
  sep: string
}

export interface Provider {
  readonly agent: AgentId
  /** Absolute store root on this machine. The store may not exist yet. */
  storeRoot(env: ProviderEnv): string
  /** Read-only. */
  discover(root: string): Promise<SessionSummary[]>
  /** Read-only. Throws when the session is missing or ambiguous. */
  collect(root: string, id: string): Promise<CollectedSession>
  /** Read-only. Says where each archive file would land and what the provider refuses. */
  inspectTarget(root: string, session: ManifestSession, context: ImportContext): Promise<TargetInspection>
  applyEffect(root: string, effect: ProviderEffect): Promise<void>
  /** Must be safe when `applyEffect` never ran or only partly ran, and safe to call twice. */
  undoEffect(root: string, effect: ProviderEffect): Promise<void>
}

/** Codex fills its slot when its provider lands. Core treats a missing slot as an unsupported agent. */
export type ProviderRegistry = Partial<Record<AgentId, Provider>>
