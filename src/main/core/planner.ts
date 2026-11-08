import type { ImportAction } from '../../shared/sessions'
import type { Sha256 } from './manifest'
import type { ProviderEffect, TargetFile, TargetInspection } from './provider'

/**
 * How the bytes import would write relate to the file already at the target path.
 * `target-is-prefix`: the target is a strict prefix of the import, so the import is newer.
 * `target-is-longer`: the import is a strict prefix of the target, so the target is newer.
 */
export type FileRelation =
  | { kind: 'absent' }
  | { kind: 'identical' }
  | { kind: 'target-is-prefix'; existingSha256: Sha256 }
  | { kind: 'target-is-longer' }
  | { kind: 'different' }

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

export interface SessionPlan {
  action: ImportAction
  writes: PlannedWrite[]
  effects: ProviderEffect[]
}

export function relate(
  planned: { sha256: Sha256; size: number; prefixSha256: Sha256 | null },
  existing: { sha256: Sha256; size: number; prefixSha256: Sha256 | null } | null,
): FileRelation {
  if (!existing) return { kind: 'absent' }
  if (planned.size === existing.size) return planned.sha256 === existing.sha256 ? { kind: 'identical' } : { kind: 'different' }
  if (existing.size < planned.size && planned.prefixSha256 === existing.sha256) {
    return { kind: 'target-is-prefix', existingSha256: existing.sha256 }
  }
  if (existing.size > planned.size && existing.prefixSha256 === planned.sha256) return { kind: 'target-is-longer' }
  return { kind: 'different' }
}

const NOTHING: Pick<SessionPlan, 'writes' | 'effects'> = { writes: [], effects: [] }

/** Pure: decides one session's import from the provider's inspection and the compared files. */
export function planSession(inspection: TargetInspection, compared: readonly ComparedFile[]): SessionPlan {
  if (inspection.kind === 'refused') return { action: inspection.action, ...NOTHING }
  if (inspection.live) {
    return {
      action: { kind: 'blocked', reason: 'live', message: 'The session is open in a running agent on this machine.' },
      ...NOTHING,
    }
  }
  const differing = compared.find((entry) => entry.relation.kind === 'different')
  if (differing) {
    return {
      action: {
        kind: 'conflict',
        reason: 'diverged',
        message: `${differing.file.path} already exists with different content. Both copies are left untouched.`,
      },
      ...NOTHING,
    }
  }
  const newer = compared.find((entry) => entry.relation.kind === 'target-is-longer')
  if (newer) {
    return {
      action: {
        kind: 'conflict',
        reason: 'target-newer',
        message: `${newer.file.path} on this machine already continues past the archived copy.`,
      },
      ...NOTHING,
    }
  }

  const writes: PlannedWrite[] = []
  for (const { file, sha256, size, relation } of compared) {
    if (relation.kind === 'absent') writes.push({ kind: 'create', file, sha256, size })
    if (relation.kind === 'target-is-prefix') {
      writes.push({ kind: 'replace', file, sha256, size, existingSha256: relation.existingSha256 })
    }
  }
  if (writes.length === 0) return { action: { kind: 'skip-identical' }, ...NOTHING }
  const allNew = compared.every((entry) => entry.relation.kind === 'absent')
  const action: ImportAction = allNew ? { kind: 'create' } : { kind: 'update', backup: true }
  return { action, writes, effects: inspection.effects }
}
