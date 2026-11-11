import type { AgentId, ConflictChoice, ConflictCopies, CopyFacts, ImportAction, ImportPreview, ImportRequest, ImportWarning, SessionImportOutcome, SessionKey } from '../../../shared/sessions'
import { pickerNote, plural, shortDateTime, tildePath } from './format'

export type Tone = 'good' | 'info' | 'neutral' | 'warn' | 'bad'

export interface Badge {
  label: string
  tone: Tone
}

type Conflict = Extract<ImportAction, { kind: 'conflict' }>

/**
 * The plan names what import will do and the result says it was done, in the same words:
 * Add and Added, Update and Updated, Replace and Replaced.
 */
export const ACTIONS: { [K in ImportAction['kind']]: Badge & { describe: (action: Extract<ImportAction, { kind: K }>) => string } } = {
  create: { label: 'Add', tone: 'good', describe: () => 'This session is not on this computer yet.' },
  update: {
    label: 'Update',
    tone: 'info',
    describe: () => 'This computer has an older copy. Agent Session Mover backs it up before the newer copy replaces it.',
  },
  'skip-identical': { label: 'Identical', tone: 'neutral', describe: () => 'This computer already has a byte-for-byte copy. There is nothing to import.' },
  conflict: { label: 'Conflict', tone: 'warn', describe: (action) => action.message },
  blocked: { label: 'Blocked', tone: 'bad', describe: (action) => action.message },
}

/**
 * True when this computer's copy holds more than the archive's: it continues past it, or its last
 * message is newer, or with no times to compare it has more messages.
 */
export function hereIsAhead(action: ImportAction): boolean {
  if (action.kind !== 'conflict') return false
  return action.reason === 'target-newer' || (action.copies !== null && lead(action.copies) > 0)
}

/** Positive when the copy here is ahead, negative when the archive's is, zero when neither shows it. */
function lead({ here, archive }: ConflictCopies): number {
  const hereAt = here.lastMessageAt ? Date.parse(here.lastMessageAt) : Number.NaN
  const archiveAt = archive.lastMessageAt ? Date.parse(archive.lastMessageAt) : Number.NaN
  if (Number.isFinite(hereAt) && Number.isFinite(archiveAt) && hereAt !== archiveAt) return Math.sign(hereAt - archiveAt)
  return Math.sign(here.messages - archive.messages)
}

export interface CopyLine {
  label: string
  text: string
  newer: boolean
}

/** The two copies of a conflict side by side, in the same terms. Empty when main could not read both. */
export function copyLines(action: Conflict): CopyLine[] {
  if (!action.copies) return []
  const ahead = hereIsAhead(action)
  const describe = (facts: CopyFacts) => {
    const count = facts.complete ? plural(facts.messages, 'message') : `At least ${plural(facts.messages, 'message')}`
    return facts.lastMessageAt ? `${count} · last ${shortDateTime(facts.lastMessageAt)}` : count
  }
  return [
    { label: "This computer's copy", text: describe(action.copies.here), newer: ahead },
    { label: "Archive's copy", text: describe(action.copies.archive), newer: !ahead && lead(action.copies) < 0 },
  ]
}

/** A conflict the user chose to replace reads as what will happen to it, and warns when the copy here holds more. */
export function planBadge(action: ImportAction, choice: ConflictChoice): Badge {
  if (action.kind === 'conflict' && choice === 'replace') return { label: 'Replace', tone: hereIsAhead(action) ? 'warn' : 'info' }
  return ACTIONS[action.kind]
}

export function describeAction(action: ImportAction): string {
  return (ACTIONS[action.kind].describe as (action: ImportAction) => string)(action)
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

export type VerdictKind = 'add' | 'update' | 'replace' | 'decide' | 'keep' | 'identical' | 'blocked' | 'left-out'

/** Where a session stands as the screen stands, in the order the verdict names them. */
export function verdictKind(action: ImportAction, included: boolean, choices: ReadonlyMap<SessionKey, ConflictChoice>, key: SessionKey): VerdictKind {
  switch (action.kind) {
    case 'create':
      return included ? 'add' : 'left-out'
    case 'update':
      return included ? 'update' : 'left-out'
    case 'conflict': {
      const choice = choices.get(key)
      return choice === 'replace' ? 'replace' : choice === 'skip' ? 'keep' : 'decide'
    }
    case 'skip-identical':
      return 'identical'
    case 'blocked':
      return 'blocked'
  }
}

const VERDICT_TEXT: Record<VerdictKind, (n: number) => string> = {
  add: (n) => `${n} will be added`,
  update: (n) => `${n} will be updated`,
  replace: (n) => `${n} will be replaced`,
  decide: (n) => `${n} ${n === 1 ? 'needs' : 'need'} a decision`,
  keep: (n) => `${n} will keep the copy here`,
  identical: (n) => `${n} already here`,
  blocked: (n) => `${n} blocked`,
  'left-out': (n) => `${n} left out`,
}

export interface VerdictPart {
  kind: VerdictKind
  text: string
}

/** Only the parts that have sessions, in a fixed order. */
export function verdict(preview: ImportPreview, excluded: ReadonlySet<SessionKey>, choices: ReadonlyMap<SessionKey, ConflictChoice>): VerdictPart[] {
  const counts = new Map<VerdictKind, number>()
  for (const { key, action } of preview.sessions) {
    const kind = verdictKind(action, !excluded.has(key), choices, key)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return (Object.keys(VERDICT_TEXT) as VerdictKind[]).flatMap((kind) => (counts.has(kind) ? [{ kind, text: VERDICT_TEXT[kind](counts.get(kind)!) }] : []))
}

/** Conflicts lead because they wait on the user, then what import writes, then what it cannot. Identical sessions fold away last. */
export function planRank(action: ImportAction | null): number {
  switch (action?.kind) {
    case 'conflict':
      return 0
    case 'blocked':
      return 2
    case 'skip-identical':
      return 3
    default:
      return 1
  }
}

/**
 * A folder needs a mapping when import may write a session that ran in it: an add or update, ticked
 * or not, or a conflict the user chose to replace.
 */
export function receivesFiles(action: ImportAction, choice: ConflictChoice): boolean {
  return isActionable(action) || (action.kind === 'conflict' && choice === 'replace')
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
