import type { AgentId, ImportAction, ImportPreview, ImportWarning, SessionImportOutcome, SessionKey } from '../../../shared/sessions'
import { pickerNote } from './format'

export type Tone = 'good' | 'info' | 'neutral' | 'warn' | 'bad'

export const ACTIONS: { [K in ImportAction['kind']]: { label: string; tone: Tone; describe: (action: Extract<ImportAction, { kind: K }>) => string } } = {
  create: { label: 'Create', tone: 'good', describe: () => 'Not on this machine yet.' },
  update: { label: 'Update', tone: 'info', describe: () => 'This machine has an older copy. It is backed up before the newer one replaces it.' },
  'skip-identical': { label: 'Identical', tone: 'neutral', describe: () => 'Already here, byte for byte. Nothing to import.' },
  conflict: { label: 'Conflict', tone: 'warn', describe: (action) => action.message },
  blocked: { label: 'Blocked', tone: 'bad', describe: (action) => action.message },
}

export function describeAction(action: ImportAction): string {
  return (ACTIONS[action.kind].describe as (action: ImportAction) => string)(action)
}

export function isActionable(action: ImportAction): boolean {
  return action.kind === 'create' || action.kind === 'update'
}

export function selectedForImport(preview: ImportPreview | null, excluded: ReadonlySet<SessionKey>): SessionKey[] {
  if (!preview) return []
  return preview.sessions.filter((session) => isActionable(session.action) && !excluded.has(session.key)).map((session) => session.key)
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
      return outcome.backupDir ? 'Files replaced. The old copy is in the backup folder.' : 'Files replaced.'
    case 'skipped':
      return 'Already identical on this machine.'
    case 'refused':
      return `Not imported. ${describeAction(outcome.action)}`
    case 'failed':
      return outcome.rolledBack
        ? `${outcome.error} Every change for this session was rolled back.`
        : `${outcome.error} Rollback did not finish. Agent Sessions retries it at the next launch.`
  }
}
