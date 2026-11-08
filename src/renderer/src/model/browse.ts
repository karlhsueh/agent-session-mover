import type { AgentId, ClientKind, SessionSummary } from '../../../shared/sessions'
import { AGENT_LABEL, CLIENT_LABEL, folderName, sessionTitle } from './format'

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
  sort: SortKey
}

export const EMPTY_QUERY: BrowseQuery = { text: '', agent: null, client: null, sort: 'activity' }

export function isFiltered(query: BrowseQuery): boolean {
  return query.text.trim() !== '' || query.agent !== null || query.client !== null
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
