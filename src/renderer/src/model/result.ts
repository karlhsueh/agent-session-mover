import type { ImportAction, ImportPreview, ImportResult, SessionImportOutcome, SessionInfo, SessionKey } from '../../../shared/sessions'
import { sessionTitle, shortCommand } from './format'
import { type Badge, describeAction, describeOutcome, outcomeBadge } from './importing'

export interface ResultEntry {
  key: SessionKey
  title: string
  badge: Badge
  message: string | null
  /** Shown as `cd ~/'…' && …`, which is also what Copy puts on the clipboard. */
  resume: string | null
}

/** One project folder on this computer that import wrote to, or tried to. */
export interface FolderGroup {
  /** Null for a session that has no folder. */
  folder: string | null
  /** The distinct branches the folder's sessions were on, sorted. */
  branches: string[]
  missing: boolean
  entries: ResultEntry[]
}

export type QuietKind = 'identical' | 'kept' | 'blocked' | 'left-out'

/** A session import did not write. It stays in the record so the result accounts for the whole archive. */
export interface QuietEntry extends ResultEntry {
  kind: QuietKind
  folder: string | null
}

export interface ResultAccount {
  groups: FolderGroup[]
  quiet: QuietEntry[]
  placed: number
  failed: number
}

const QUIET_BADGE: Record<QuietKind, Badge> = {
  identical: { label: 'Identical', tone: 'neutral' },
  kept: { label: 'Kept', tone: 'neutral' },
  blocked: { label: 'Blocked', tone: 'bad' },
  'left-out': { label: 'Left out', tone: 'neutral' },
}

const QUIET_COUNT: Record<QuietKind, (n: number) => string> = {
  identical: (n) => `${n} already on this computer`,
  kept: (n) => `${n} kept the copy here`,
  blocked: (n) => `${n} blocked`,
  'left-out': (n) => `${n} left out`,
}

export function quietSummary(quiet: readonly QuietEntry[]): string {
  return (Object.keys(QUIET_COUNT) as QuietKind[])
    .map((kind) => [kind, quiet.filter((entry) => entry.kind === kind).length] as const)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => QUIET_COUNT[kind](n))
    .join(' · ')
}

const trim = (path: string) => path.replace(/[\\/]+$/, '')

function quietKind(source: SessionImportOutcome | ImportAction): QuietKind | null {
  if ('status' in source) {
    if (source.status === 'skipped') return 'identical'
    if (source.status === 'refused') return source.action.kind === 'conflict' ? 'kept' : 'blocked'
    return null
  }
  switch (source.kind) {
    case 'skip-identical':
      return 'identical'
    case 'conflict':
      return 'kept'
    case 'blocked':
      return 'blocked'
    default:
      return 'left-out'
  }
}

const QUIET_MESSAGE: Record<Exclude<QuietKind, 'blocked'>, string> = {
  identical: 'This computer already has an identical copy.',
  kept: 'Agent Session Mover kept the copy on this computer.',
  'left-out': 'You unticked this session, so import left it out.',
}

/**
 * Groups what import wrote by the folder each session resumes from, and keeps every other session of
 * the archive as a quiet entry. Sessions that were not sent to import take their state from the plan.
 */
export function accountFor(sessions: readonly SessionInfo[], result: ImportResult, plan: ImportPreview | null, home: string): ResultAccount {
  const outcomes = new Map(result.outcomes.map((outcome) => [outcome.key, outcome]))
  const planned = new Map((plan?.sessions ?? []).map((entry) => [entry.key, entry]))
  const groups = new Map<string | null, FolderGroup>()
  const quiet: QuietEntry[] = []
  let placed = 0
  let failed = 0
  const ordered = [...sessions].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
  for (const session of ordered) {
    const outcome = outcomes.get(session.key)
    const entry = planned.get(session.key)
    const folder = entry?.targetCwd ? trim(entry.targetCwd) : null
    const title = sessionTitle(session)
    const source = outcome ?? entry?.action
    if (!source) continue
    const kind = quietKind(source)
    if (kind) {
      const message = kind === 'blocked' ? (outcome ? describeOutcome(outcome) : describeAction(source as ImportAction)) : QUIET_MESSAGE[kind]
      quiet.push({ key: session.key, title, badge: QUIET_BADGE[kind], message, resume: null, kind, folder })
      continue
    }
    if (!outcome) continue
    if (outcome.status === 'failed') failed += 1
    else placed += 1
    let group = groups.get(folder)
    if (!group) {
      group = { folder, branches: [], missing: false, entries: [] }
      groups.set(folder, group)
    }
    if (session.gitBranch && !group.branches.includes(session.gitBranch)) group.branches.push(session.gitBranch)
    if (entry?.warnings.some((warning) => warning.code === 'target-cwd-missing' && trim(warning.path) === folder)) group.missing = true
    group.entries.push({
      key: session.key,
      title,
      badge: outcomeBadge(outcome),
      message: describeOutcome(outcome),
      resume: 'resumeCommand' in outcome ? shortCommand(outcome.resumeCommand, home) : null,
    })
  }
  for (const group of groups.values()) group.branches.sort()
  // A folder that still has to be cloned is the next thing to do, so it leads.
  const list = [...groups.values()].sort((a, b) => Number(b.missing) - Number(a.missing))
  return { groups: list, quiet, placed, failed }
}
