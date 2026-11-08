import type { AgentId, ClientKind, SessionSummary } from '../../../shared/sessions'
import { AGENT_LABEL, CLIENT_LABEL, folderName, parentFolder, sessionTitle } from './format'

type Compare = (a: SessionSummary, b: SessionSummary) => number
const byActivity: Compare = (a, b) => b.lastActivity.localeCompare(a.lastActivity)

export const SORTS = {
  activity: { label: 'Last activity', compare: byActivity },
  title: { label: 'Title', compare: (a, b) => sessionTitle(a).localeCompare(sessionTitle(b)) },
  project: { label: 'Project', compare: (a, b) => folderName(a.cwd).localeCompare(folderName(b.cwd)) || byActivity(a, b) },
  size: { label: 'Size', compare: (a, b) => b.sizeBytes - a.sizeBytes },
} satisfies Record<string, { label: string; compare: Compare }>

export type SortKey = keyof typeof SORTS

export interface BrowseQuery {
  text: string
  agent: AgentId | null
  client: ClientKind | null
  /** A session's starting cwd, or NO_FOLDER for sessions that recorded none. */
  project: string | null
  sort: SortKey
}

/** Not a path any OS produces, so it cannot collide with a real cwd. */
export const NO_FOLDER = '\u0000no-folder'

export const EMPTY_QUERY: BrowseQuery = { text: '', agent: null, client: null, project: null, sort: 'activity' }

export function isFiltered(query: BrowseQuery): boolean {
  return query.text.trim() !== '' || query.agent !== null || query.client !== null || query.project !== null
}

export function visibleSessions(sessions: readonly SessionSummary[], query: BrowseQuery): SessionSummary[] {
  const needle = query.text.trim().toLowerCase()
  return sessions
    .filter(
      (session) =>
        (query.agent === null || session.agent === query.agent) &&
        (query.client === null || session.client === query.client) &&
        (query.project === null || (session.cwd ?? NO_FOLDER) === query.project) &&
        (needle === '' || [sessionTitle(session), session.id, ...session.cwds].some((field) => field.toLowerCase().includes(needle))),
    )
    .sort(SORTS[query.sort].compare)
}

export interface Option<T> {
  value: T
  label: string
}

export function agentOptions(sessions: readonly SessionSummary[]): Option<AgentId>[] {
  return [...new Set(sessions.map((session) => session.agent))].map((agent) => ({ value: agent, label: AGENT_LABEL[agent] }))
}

export function clientOptions(sessions: readonly SessionSummary[]): Option<ClientKind>[] {
  return [...new Set(sessions.map((session) => session.client))].sort().map((client) => ({ value: client, label: CLIENT_LABEL[client] }))
}

/** One option per starting folder. Two folders with the same name also show their parent. */
export function projectOptions(sessions: readonly SessionSummary[]): Option<string>[] {
  const counts = new Map<string, number>()
  for (const session of sessions) counts.set(session.cwd ?? NO_FOLDER, (counts.get(session.cwd ?? NO_FOLDER) ?? 0) + 1)
  const nameOf = (cwd: string) => folderName(cwd === NO_FOLDER ? null : cwd)
  const nameUses = new Map<string, number>()
  for (const cwd of counts.keys()) nameUses.set(nameOf(cwd), (nameUses.get(nameOf(cwd)) ?? 0) + 1)
  return [...counts]
    .map(([cwd, count]) => {
      const name = nameOf(cwd)
      const label = cwd !== NO_FOLDER && (nameUses.get(name) ?? 0) > 1 ? `${parentFolder(cwd)}/${name}` : name
      return { value: cwd, label: `${label} (${count})` }
    })
    .sort((a, b) => a.label.localeCompare(b.label))
}
