import path from 'node:path'
import { isSessionId } from '../../../shared/sessions'
import type { ProviderEffect } from '../../core/provider'
import { appendIndexLine, removeIndexLine } from './session-index'
import { applyEdge, type EdgeChange, undoEdge } from './spawn-edges'
import { applyRowChange, DB_FILE, isRow, type RowChange, undoRowChange } from './state-db'

/** The writes a Codex import makes besides files. Each is journaled as plain JSON before it runs. */
export type CodexEffect =
  | ({ kind: 'thread-row' } & RowChange)
  | ({ kind: 'spawn-edge' } & EdgeChange)
  /** `createsFile` says the index did not exist at planning, so undo removes the file once it is empty again. */
  | { kind: 'index-line'; line: string; createsFile: boolean }

/** Effects come back from a journal on disk during recovery, so they are checked like any other input. */
export function parseEffect(value: ProviderEffect): CodexEffect {
  const v = value as Record<string, unknown>
  const db = typeof v.db === 'string' && path.isAbsolute(v.db) && path.basename(v.db) === DB_FILE ? v.db : null
  if (
    v.kind === 'thread-row' &&
    db !== null &&
    typeof v.id === 'string' &&
    isRow(v.row) &&
    (v.prior === null || isRow(v.prior))
  ) {
    return { kind: 'thread-row', db, id: v.id, row: v.row, prior: v.prior }
  }
  if (v.kind === 'spawn-edge' && db !== null && isSessionId(v.parent) && isSessionId(v.child)) {
    return { kind: 'spawn-edge', db, parent: v.parent, child: v.child }
  }
  if (v.kind === 'index-line' && typeof v.line === 'string' && v.line !== '' && !/[\r\n]/.test(v.line) && typeof v.createsFile === 'boolean') {
    return { kind: 'index-line', line: v.line, createsFile: v.createsFile }
  }
  throw new Error('Not a Codex import effect')
}

export async function applyEffect(root: string, effect: CodexEffect): Promise<void> {
  if (effect.kind === 'thread-row') await applyRowChange(effect)
  else if (effect.kind === 'spawn-edge') await applyEdge(effect)
  else await appendIndexLine(root, effect.line)
}

export async function undoEffect(root: string, effect: CodexEffect): Promise<void> {
  if (effect.kind === 'thread-row') await undoRowChange(effect)
  else if (effect.kind === 'spawn-edge') await undoEdge(effect)
  else await removeIndexLine(root, effect.line, effect.createsFile)
}
