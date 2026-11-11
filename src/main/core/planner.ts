import type { ConflictChoice, ImportAction } from '../../shared/sessions'
import type { Sha256 } from './manifest'
import type { ProviderEffect, TargetFile, TargetInspection } from './provider'

/**
 * How the bytes import would write relate to the file already at the target path.
 * `target-is-prefix`: the target is a strict prefix of the import, so the import is newer.
 * `target-is-longer`: the import is a strict prefix of the target, so the target is newer.
 * `existingSha256` is the hash of the stored bytes, which the executor checks before it backs them up.
 */
export type FileRelation =
  | { kind: 'absent' }
  | { kind: 'identical' }
  | { kind: 'target-is-prefix'; existingSha256: Sha256 }
  | { kind: 'target-is-longer'; existingSha256: Sha256 }
  | { kind: 'different'; existingSha256: Sha256 }

export interface ComparedFile {
  file: TargetFile
  /** Hash and size of the bytes import would write, after the provider's transform. */
  sha256: Sha256
  size: number
  relation: FileRelation
}

export type PlannedWrite =
  | { kind: 'create'; file: TargetFile; sha256: Sha256; size: number }
  | { kind: 'replace'; file: TargetFile; sha256: Sha256; size: number; existingSha256: Sha256 }

export interface PlannedChanges {
  writes: PlannedWrite[]
  effects: ProviderEffect[]
}

type ConflictAction = Extract<ImportAction, { kind: 'conflict' }>

/** A conflict writes nothing unless the user chooses `replace`, which applies `replace` instead. */
export type SessionPlan =
  | ({ action: Exclude<ImportAction, { kind: 'conflict' }> } & PlannedChanges)
  | { action: ConflictAction; writes: []; effects: []; replace: PlannedChanges }

/** What import writes for a plan, given the user's choice for a conflict. */
export function changesFor(plan: SessionPlan, choice: ConflictChoice): PlannedChanges {
  return 'replace' in plan && choice === 'replace' ? plan.replace : plan
}

export function relate(
  planned: { sha256: Sha256; size: number; prefixSha256: Sha256 | null },
  existing: { sha256: Sha256; size: number; prefixSha256: Sha256 | null } | null,
): FileRelation {
  if (!existing) return { kind: 'absent' }
  const existingSha256 = existing.sha256
  if (planned.size === existing.size) return planned.sha256 === existing.sha256 ? { kind: 'identical' } : { kind: 'different', existingSha256 }
  if (existing.size < planned.size && planned.prefixSha256 === existing.sha256) return { kind: 'target-is-prefix', existingSha256 }
  if (existing.size > planned.size && existing.prefixSha256 === planned.sha256) return { kind: 'target-is-longer', existingSha256 }
  return { kind: 'different', existingSha256 }
}

const NOTHING = { writes: [], effects: [] } satisfies PlannedChanges

const CONFLICT_MESSAGE: Record<ConflictAction['reason'], string> = {
  diverged: 'This computer already has a different copy of this session.',
  'target-newer': "This computer's copy of this session goes further than the one in the archive.",
}

/** Pure: decides one session's import from the provider's inspection and the compared files. */
export function planSession(inspection: TargetInspection, compared: readonly ComparedFile[]): SessionPlan {
  if (inspection.kind === 'refused') return { action: inspection.action, ...NOTHING }
  if (inspection.live) {
    return {
      action: { kind: 'blocked', reason: 'live', message: 'The session is open in a running agent on this computer. Quit it, then import again.' },
      ...NOTHING,
    }
  }

  const writes: PlannedWrite[] = []
  for (const { file, sha256, size, relation } of compared) {
    if (relation.kind === 'absent') writes.push({ kind: 'create', file, sha256, size })
    else if (relation.kind !== 'identical') writes.push({ kind: 'replace', file, sha256, size, existingSha256: relation.existingSha256 })
  }
  const conflicting = compared.filter((entry) => entry.relation.kind === 'different' || entry.relation.kind === 'target-is-longer')
  if (conflicting.length > 0) {
    const reason = conflicting.some((entry) => entry.relation.kind === 'different') ? 'diverged' : 'target-newer'
    return {
      action: { kind: 'conflict', reason, message: CONFLICT_MESSAGE[reason], copies: null },
      writes: [],
      effects: [],
      replace: { writes, effects: inspection.effects },
    }
  }
  if (writes.length === 0) return { action: { kind: 'skip-identical' }, ...NOTHING }
  const allNew = compared.every((entry) => entry.relation.kind === 'absent')
  const action: ImportAction = allNew ? { kind: 'create' } : { kind: 'update', backup: true }
  return { action, writes, effects: inspection.effects }
}
