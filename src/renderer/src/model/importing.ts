import type { AgentId, ConflictChoice, ImportAction, ImportPreview, ImportRequest, ImportWarning, SessionImportOutcome, SessionInfo, SessionKey } from '../../../shared/sessions'
import { pickerNote, shortDateTime } from './format'

export type Tone = 'good' | 'info' | 'neutral' | 'warn' | 'bad'

type Described = Pick<SessionInfo, 'lastActivity'>

export const ACTIONS: { [K in ImportAction['kind']]: { label: string; tone: Tone; describe: (action: Extract<ImportAction, { kind: K }>, session: Described | null) => string } } = {
  create: { label: 'Create', tone: 'good', describe: () => 'This session is not on this machine yet.' },
  update: { label: 'Update', tone: 'info', describe: () => 'This machine has an older copy. Agent Session Mover backs it up before the newer copy replaces it.' },
  'skip-identical': { label: 'Identical', tone: 'neutral', describe: () => 'This machine already has a byte-for-byte copy. There is nothing to import.' },
  conflict: { label: 'Conflict', tone: 'warn', describe: describeConflict },
  blocked: { label: 'Blocked', tone: 'bad', describe: (action) => action.message },
}

const CONFLICT_LEAD: Record<Extract<ImportAction, { kind: 'conflict' }>['reason'], string> = {
  diverged: 'This computer already has a different copy of this session',
  'target-newer': "This computer's copy of this session goes further than the archive's",
}

/** Dates let the user judge which copy to keep. */
function describeConflict(action: Extract<ImportAction, { kind: 'conflict' }>, session: Described | null): string {
  if (!action.hereChangedAt) return action.message
  const here = `${CONFLICT_LEAD[action.reason]}, last changed ${shortDateTime(action.hereChangedAt)}.`
  return session ? `${here} The archive's copy was last active ${shortDateTime(session.lastActivity)}.` : here
}

/** A conflict the user chose to replace reads as what will happen to it. */
export function planBadge(action: ImportAction, choice: ConflictChoice): { label: string; tone: Tone } {
  return action.kind === 'conflict' && choice === 'replace' ? { label: 'Replace', tone: 'info' } : ACTIONS[action.kind]
}

export function describeAction(action: ImportAction, session: Described | null = null): string {
  return (ACTIONS[action.kind].describe as (action: ImportAction, session: Described | null) => string)(action, session)
}

export function isActionable(action: ImportAction): boolean {
  return action.kind === 'create' || action.kind === 'update'
}

/** Skip unless the user picked Replace, so nothing on this computer is replaced by default. */
export function conflictChoice(choices: ReadonlyMap<SessionKey, ConflictChoice>, key: SessionKey): ConflictChoice {
  return choices.get(key) ?? 'skip'
}

/**
 * Ticked sessions that create or update, plus conflicts the user chose to replace. A ticked session
 * that turns out to conflict when import plans again is skipped.
 */
export function selectedForImport(preview: ImportPreview | null, excluded: ReadonlySet<SessionKey>, choices: ReadonlyMap<SessionKey, ConflictChoice>): ImportRequest[] {
  if (!preview) return []
  return preview.sessions.flatMap(({ key, action }): ImportRequest[] => {
    if (isActionable(action)) return excluded.has(key) ? [] : [{ key, onConflict: 'skip' }]
    return action.kind === 'conflict' && conflictChoice(choices, key) === 'replace' ? [{ key, onConflict: 'replace' }] : []
  })
}

export function conflictKeys(preview: ImportPreview | null): SessionKey[] {
  return (preview?.sessions ?? []).filter((session) => session.action.kind === 'conflict').map((session) => session.key)
}

export function warningText(warning: ImportWarning, agent: AgentId): string {
  switch (warning.code) {
    case 'target-cwd-missing':
      return `${warning.path} does not exist on this machine. The files import, but you need that folder to resume from it.`
    case 'hidden-from-picker':
      return pickerNote(agent, warning.clientDetail)
  }
}

export const OUTCOMES: Record<SessionImportOutcome['status'], { label: string; tone: Tone }> = {
  created: { label: 'Placed', tone: 'good' },
  updated: { label: 'Updated', tone: 'info' },
  replaced: { label: 'Replaced', tone: 'info' },
  skipped: { label: 'Skipped', tone: 'neutral' },
  refused: { label: 'Refused', tone: 'warn' },
  failed: { label: 'Failed', tone: 'bad' },
}

/** Null when the badge already says everything. */
export function describeOutcome(outcome: SessionImportOutcome): string | null {
  switch (outcome.status) {
    case 'created':
      return null
    case 'updated':
      return outcome.backupDir ? 'The import replaced the files. The old copy is in the backup folder.' : 'The import replaced the files.'
    case 'replaced':
      return "The archive's copy replaced the one on this computer. The copy that was here is in the backup folder."
    case 'skipped':
      return 'This machine already has an identical copy.'
    case 'refused':
      return outcome.action.kind === 'conflict'
        ? `Agent Session Mover kept the copy on this computer. ${outcome.action.message}`
        : `Agent Session Mover did not import this session. ${describeAction(outcome.action)}`
    case 'failed':
      return outcome.rolledBack
        ? `${outcome.error} Agent Session Mover rolled back every change for this session.`
        : `${outcome.error} Rollback did not finish. Agent Session Mover retries it at the next launch.`
  }
}
