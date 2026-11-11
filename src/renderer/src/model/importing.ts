import type { AgentId, ConflictChoice, ImportAction, ImportPreview, ImportRequest, ImportWarning, SessionImportOutcome, SessionInfo, SessionKey } from '../../../shared/sessions'
import { pickerNote, plural, shortDateTime, tildePath } from './format'

export type Tone = 'good' | 'info' | 'neutral' | 'warn' | 'bad'

export interface Badge {
  label: string
  tone: Tone
}

type Described = Pick<SessionInfo, 'lastActivity'>
type Conflict = Extract<ImportAction, { kind: 'conflict' }>

/**
 * The plan names what import will do and the result says it was done, in the same words:
 * Add and Added, Update and Updated, Replace and Replaced.
 */
export const ACTIONS: {
  [K in ImportAction['kind']]: Badge & { count: (n: number) => string; describe: (action: Extract<ImportAction, { kind: K }>, session: Described | null) => string }
} = {
  create: { label: 'Add', tone: 'good', count: (n) => `${n} to add`, describe: () => 'This session is not on this computer yet.' },
  update: {
    label: 'Update',
    tone: 'info',
    count: (n) => `${n} to update`,
    describe: () => 'This computer has an older copy. Agent Session Mover backs it up before the newer copy replaces it.',
  },
  'skip-identical': { label: 'Identical', tone: 'neutral', count: (n) => `${n} identical`, describe: () => 'This computer already has a byte-for-byte copy. There is nothing to import.' },
  conflict: { label: 'Conflict', tone: 'warn', count: (n) => plural(n, 'conflict'), describe: describeConflict },
  blocked: { label: 'Blocked', tone: 'bad', count: (n) => `${n} blocked`, describe: (action) => action.message },
}

const CONFLICT_LEAD: Record<Conflict['reason'], string> = {
  diverged: 'This computer already has a different copy of this session',
  'target-newer': "This computer's copy of this session goes further than the archive's",
}

/** Dates let the user judge which copy to keep. */
function describeConflict(action: Conflict, session: Described | null): string {
  if (!action.hereChangedAt) return action.message
  const here = `${CONFLICT_LEAD[action.reason]}, last changed ${shortDateTime(action.hereChangedAt)}.`
  return session ? `${here} The archive's copy was last active ${shortDateTime(session.lastActivity)}.` : here
}

/** A conflict the user chose to replace reads as what will happen to it. */
export function planBadge(action: ImportAction, choice: ConflictChoice): Badge {
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

/** True when import will write this session as the screen stands. */
export function willImport(action: ImportAction, included: boolean, choice: ConflictChoice): boolean {
  return isActionable(action) ? included : action.kind === 'conflict' && choice === 'replace'
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

/** `listed` is true when the Folders section already shows the missing folder with its Create folder button. */
export function warningText(warning: ImportWarning, agent: AgentId, home: string, listed: boolean): string {
  switch (warning.code) {
    case 'target-cwd-missing':
      return listed
        ? 'Its folder does not exist yet. See Folders above.'
        : `${tildePath(warning.path, home)} does not exist yet. The files import, but you need that folder to resume from it.`
    case 'hidden-from-picker':
      return pickerNote(agent, warning.clientDetail)
  }
}

export function outcomeBadge(outcome: SessionImportOutcome): Badge {
  switch (outcome.status) {
    case 'created':
      return { label: 'Added', tone: 'good' }
    case 'updated':
      return { label: 'Updated', tone: 'info' }
    case 'replaced':
      return { label: 'Replaced', tone: 'info' }
    case 'skipped':
      return { label: 'Identical', tone: 'neutral' }
    case 'refused':
      return outcome.action.kind === 'conflict' ? { label: 'Kept', tone: 'warn' } : { label: 'Blocked', tone: 'bad' }
    case 'failed':
      return { label: 'Failed', tone: 'bad' }
  }
}

/** What to do about a project folder before resuming. No repo URL travels in the archive, so the hint names only the branch. */
export interface FolderHint {
  text: string
  /** A command worth copying, or null when there is no single one. */
  command: string | null
}

export function missingFolderHint(branches: readonly string[]): FolderHint {
  if (branches.length === 1) return { text: 'Clone the repo here, then run', command: `git checkout ${branches[0]}` }
  if (branches.length === 0) return { text: 'Clone the repo here, or copy the project from the other computer.', command: null }
  return { text: `Clone the repo here, then check out ${branches.slice(0, -1).join(', ')} or ${branches.at(-1)}.`, command: null }
}

export function existingFolderHint(branches: readonly string[]): string {
  if (branches.length === 1) return `Pull the latest changes on ${branches[0]} before you resume.`
  return 'Pull the latest changes before you resume.'
}

/** Null when the badge already says everything. */
export function describeOutcome(outcome: SessionImportOutcome): string | null {
  switch (outcome.status) {
    case 'created':
      return null
    case 'updated':
      return outcome.backupDir ? 'The newer copy replaced the older one. The older copy is in the backup folder.' : 'The newer copy replaced the older one.'
    case 'replaced':
      return "The archive's copy replaced the one on this computer. The copy that was here is in the backup folder."
    case 'skipped':
      return 'This computer already has an identical copy.'
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
