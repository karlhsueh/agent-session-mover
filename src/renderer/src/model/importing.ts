import {
  type AgentId,
  type ArchiveSummary,
  type ConflictChoice,
  type ConflictCopies,
  type CopyFacts,
  type ImportAction,
  type ImportPreview,
  type ImportRequest,
  type ImportWarning,
  isAtOrUnder,
  mapPath,
  type PathMapping,
  type SessionImportOutcome,
  type SessionKey,
} from '../../../shared/sessions'
import { isWindowsHome, pickerNote, plural, shellPath, shellWord, shortDateTime, tildePath } from './format'

export type Tone = 'good' | 'info' | 'neutral' | 'warn' | 'bad'

export interface Badge {
  label: string
  tone: Tone
}

type Conflict = Extract<ImportAction, { kind: 'conflict' }>

/** Reasons a session cannot be placed that point at a damaged archive or store, not at a state the user can change. */
const BLOCKED_ERRORS: ReadonlySet<string> = new Set(['invalid-session', 'unsafe-path'])

/** Blocked reads as an error only when something is actually wrong. A live or newer session here is just left alone. */
export function blockedTone(action: ImportAction): Tone {
  return action.kind === 'blocked' && BLOCKED_ERRORS.has(action.reason) ? 'bad' : 'neutral'
}

/**
 * The plan names what import will do and the result says it was done, in the same words:
 * Add and Added, Update and Updated, Replace and Replaced, Keep and Kept.
 */
export const ACTIONS: { [K in ImportAction['kind']]: Badge & { describe: (action: Extract<ImportAction, { kind: K }>) => string } } = {
  create: { label: 'Add', tone: 'good', describe: () => 'This session is not on this computer yet.' },
  update: {
    label: 'Update',
    tone: 'info',
    describe: () => 'This computer has an older copy. Agent Session Mover backs it up before the newer copy replaces it.',
  },
  'skip-identical': { label: 'Identical', tone: 'neutral', describe: () => 'This computer already has a byte-for-byte copy. There is nothing to import.' },
  conflict: { label: 'Keep', tone: 'neutral', describe: (action) => action.message },
  blocked: { label: 'Blocked', tone: 'neutral', describe: (action) => action.message },
}

function time(at: string | null): number {
  return at ? Date.parse(at) : Number.NaN
}

/** Positive when the copy here has the later last message, negative when the archive's does, zero when that cannot be told. */
function laterLast({ here, archive }: ConflictCopies): number {
  const hereAt = time(here.lastMessageAt)
  const archiveAt = time(archive.lastMessageAt)
  return Number.isFinite(hereAt) && Number.isFinite(archiveAt) ? Math.sign(hereAt - archiveAt) : 0
}

/** Counts compare only when both transcripts were read whole. */
const counted = ({ here, archive }: ConflictCopies) => here.complete && archive.complete

/**
 * True when replacing would set aside messages only this computer has: its last message is later, or
 * it has more of them. Extra lines that are not messages do not count. Without both transcripts, a
 * copy here that continues past the archive's is assumed to.
 */
export function hereIsAhead(action: ImportAction): boolean {
  if (action.kind !== 'conflict') return false
  if (!action.copies) return action.reason === 'target-newer'
  return laterLast(action.copies) > 0 || (counted(action.copies) && action.copies.here.messages > action.copies.archive.messages)
}

export interface CopyLine {
  label: string
  text: string
  /** What this copy has that the other does not, such as `1 more message`, or null. */
  more: string | null
  /** Its last message is later than the other copy's. */
  newer: boolean
}

/** What one copy has over the other. Messages first, then lines when the messages match. */
function moreThan(facts: CopyFacts, other: CopyFacts, comparable: boolean): string | null {
  if (!comparable) return null
  if (facts.messages > other.messages) return `${plural(facts.messages - other.messages, 'more message')}`
  if (facts.messages === other.messages && facts.lines > other.lines) return `same messages, ${plural(facts.lines - other.lines, 'more line')}`
  return null
}

/** The two copies of a conflict side by side, in the same terms. Empty when main could not read both. */
export function copyLines(action: Conflict): CopyLine[] {
  const { copies } = action
  if (!copies) return []
  const comparable = counted(copies)
  const later = laterLast(copies)
  const describe = (facts: CopyFacts) => {
    const count = facts.complete ? plural(facts.messages, 'message') : `At least ${plural(facts.messages, 'message')}`
    return facts.lastMessageAt ? `${count} · last ${shortDateTime(facts.lastMessageAt)}` : count
  }
  return [
    { label: "This computer's copy", text: describe(copies.here), more: moreThan(copies.here, copies.archive, comparable), newer: later > 0 },
    { label: "Archive's copy", text: describe(copies.archive), more: moreThan(copies.archive, copies.here, comparable), newer: later < 0 },
  ]
}

/**
 * A conflict reads as what import will do with it, Keep until the user picks Replace. Replace keeps the
 * same tone in the plan and the result, so the warning for newer messages here sits beside the choice.
 */
export function planBadge(action: ImportAction, choice: ConflictChoice): Badge {
  if (action.kind === 'conflict' && choice === 'replace') return { label: 'Replace', tone: 'info' }
  if (action.kind === 'blocked') return { label: 'Blocked', tone: blockedTone(action) }
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

/** The start button names what it does, and the footer mentions backups only when something is replaced. */
export function runSummary(preview: ImportPreview | null, requests: readonly ImportRequest[]): { label: string; backups: string | null } {
  const actions = new Map((preview?.sessions ?? []).map((session) => [session.key, session.action.kind]))
  const replaces = requests.filter((request) => actions.get(request.key) === 'conflict').length
  const updates = requests.filter((request) => actions.get(request.key) === 'update').length
  const imports = requests.length - replaces
  const label =
    requests.length === 0
      ? 'Nothing to import'
      : replaces === 0
        ? `Import ${plural(imports, 'session')}`
        : imports === 0
          ? `Replace ${plural(replaces, 'session')}`
          : `Import ${imports} · replace ${replaces}`
  const verbs = [...(updates > 0 ? ['Update'] : []), ...(replaces > 0 ? ['Replace'] : [])]
  const backups = verbs.length === 0 ? null : verbs.length === 1 ? `${verbs[0]} keeps a backup of the copy it replaces.` : 'Update and Replace keep a backup of the copy they replace.'
  return { label, backups }
}

export type VerdictKind = 'add' | 'update' | 'replace' | 'replace-newer' | 'keep' | 'identical' | 'blocked' | 'left-out'

/** Where a session stands as the screen stands, in the order the verdict names them. */
export function verdictKind(action: ImportAction, included: boolean, choices: ReadonlyMap<SessionKey, ConflictChoice>, key: SessionKey): VerdictKind {
  switch (action.kind) {
    case 'create':
      return included ? 'add' : 'left-out'
    case 'update':
      return included ? 'update' : 'left-out'
    case 'conflict':
      if (conflictChoice(choices, key) === 'skip') return 'keep'
      return hereIsAhead(action) ? 'replace-newer' : 'replace'
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
  'replace-newer': (n) => `${n} will replace ${n === 1 ? 'a copy' : 'copies'} with newer messages`,
  // A conflict nobody decided keeps the copy here, so it reads as that, not as a question.
  keep: (n) => `${n} ${n === 1 ? 'differs' : 'differ'}, keeping this computer's ${n === 1 ? 'copy' : 'copies'}`,
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
      return outcome.action.kind === 'conflict' ? { label: 'Kept', tone: 'neutral' } : { label: 'Blocked', tone: blockedTone(outcome.action) }
    case 'failed':
      return { label: 'Failed', tone: 'bad' }
  }
}

/** What to do about a project folder before resuming. */
export interface FolderHint {
  text: string
  /** A command worth copying, or null when there is no single one. */
  command: string | null
}

/** Where to clone a repo the archive names: its remote, and its folder here, quoted for the shell. */
export interface CloneTarget {
  remote: string
  folder: string
}

type Repo = ArchiveSummary['source']['repos'][number]

/**
 * The repo that held `sourceFolder` on the other computer, cloned to where its own folder maps here.
 * Null when the archive names no repo for it, or its folder sits above every mapping.
 */
export function cloneTarget(
  repos: readonly Repo[],
  sourceFolder: string | null,
  mappings: readonly PathMapping[],
  sourceSep: string,
  home: string,
): CloneTarget | null {
  if (!sourceFolder) return null
  const repo = repos.filter((each) => isAtOrUnder(sourceFolder, each.folder, sourceSep)).sort((a, b) => b.folder.length - a.folder.length)[0]
  const windows = isWindowsHome(home)
  const folder = repo && mapPath(repo.folder, mappings, sourceSep, windows ? '\\' : '/')
  return repo && folder ? { remote: repo.remote, folder: shellPath(folder, home, windows) } : null
}

export function missingFolderHint(names: readonly string[], clone: CloneTarget | null = null, home = ''): FolderHint {
  // Git refuses a branch name that starts with a dash, so one from an archive is never offered as a command.
  const branches = names.filter((branch) => !branch.startsWith('-'))
  const windows = isWindowsHome(home)
  if (clone) {
    const command = `git clone ${clone.remote} ${clone.folder}`
    if (branches.length === 1) return { text: 'To get the code, run', command: `${command} && cd ${clone.folder} && git checkout ${shellWord(branches[0]!, windows)}` }
    if (branches.length === 0) return { text: 'To get the code, run', command }
    return { text: `To get the code, run this, then check out ${branchWords(branches)}.`, command }
  }
  if (branches.length === 1) return { text: 'Clone the repo here, then run', command: `git checkout ${shellWord(branches[0]!, windows)}` }
  if (branches.length === 0) return { text: 'Clone the repo here, or copy the project from the other computer.', command: null }
  return { text: `Clone the repo here, then check out ${branchWords(branches)}.`, command: null }
}

const branchWords = (branches: readonly string[]) => `${branches.slice(0, -1).join(', ')} or ${branches.at(-1)}`

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
