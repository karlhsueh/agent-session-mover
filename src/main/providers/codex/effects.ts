import path from 'node:path'
import type { ProviderEffect } from '../../core/provider'
import { appendIndexLine, removeIndexLine } from './session-index'
import { applyRowChange, DB_FILE, isRow, type RowChange, undoRowChange } from './state-db'

/** The writes a Codex import makes besides files. Each is journaled as plain JSON before it runs. */
export type CodexEffect =
  | ({ kind: 'thread-row' } & RowChange)
  /** `createsFile` says the index did not exist at planning, so undo removes the file once it is empty again. */
  | { kind: 'index-line'; line: string; createsFile: boolean }

/** Effects come back from a journal on disk during recovery, so they are checked like any other input. */
export function parseEffect(value: ProviderEffect): CodexEffect {
  const v = value as Record<string, unknown>
  if (
    v.kind === 'thread-row' &&
    typeof v.db === 'string' &&
    path.isAbsolute(v.db) &&
    path.basename(v.db) === DB_FILE &&
    typeof v.id === 'string' &&
    isRow(v.row) &&
    (v.prior === null || isRow(v.prior))
  ) {
    return { kind: 'thread-row', db: v.db, id: v.id, row: v.row, prior: v.prior }
  }
  if (v.kind === 'index-line' && typeof v.line === 'string' && v.line !== '' && !/[\r\n]/.test(v.line) && typeof v.createsFile === 'boolean') {
    return { kind: 'index-line', line: v.line, createsFile: v.createsFile }
  }
  throw new Error('Not a Codex import effect')
}

export async function applyEffect(root: string, effect: CodexEffect): Promise<void> {
  if (effect.kind === 'thread-row') await applyRowChange(effect)
  else await appendIndexLine(root, effect.line)
}

export async function undoEffect(root: string, effect: CodexEffect): Promise<void> {
  if (effect.kind === 'thread-row') await undoRowChange(effect)
  else await removeIndexLine(root, effect.line, effect.createsFile)
}
