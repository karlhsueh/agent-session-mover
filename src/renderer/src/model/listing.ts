import type { ApiResult } from '../../../shared/ipc'
import { AGENT_IDS, type AgentId, type ScanProgress, type SessionList } from '../../../shared/sessions'

/** One agent's sessions as this window knows them. Null until its first answer arrives. */
export type Listings = Record<AgentId, SessionList | null>

export const NO_LISTINGS: Listings = Object.fromEntries(AGENT_IDS.map((agent) => [agent, null])) as Listings

/**
 * Folds one agent's answer in. A failed call becomes a problem for that agent, so the others still show.
 * An answer equal to what is shown keeps the old object, so a refresh that found nothing new re-renders nothing.
 */
export function withAnswer(listings: Listings, agent: AgentId, result: ApiResult<SessionList>): Listings {
  const next: SessionList = result.ok ? result.value : { sessions: [], problems: [{ agent, message: result.error.message }] }
  const current = listings[agent]
  if (current && JSON.stringify(current) === JSON.stringify(next)) return listings
  return { ...listings, [agent]: next }
}

/** Every answered agent's sessions, newest activity first. Null while no agent has answered. */
export function mergedList(listings: Listings): SessionList | null {
  const answered = AGENT_IDS.flatMap((agent) => listings[agent] ?? [])
  if (answered.length === 0) return null
  return {
    sessions: answered.flatMap((list) => list.sessions).sort((a, b) => b.lastActivity.localeCompare(a.lastActivity)),
    problems: answered.flatMap((list) => list.problems),
  }
}

/** An agent this window is still waiting on, with its latest progress once it reports any. */
export interface PendingScan {
  agent: AgentId
  progress: ScanProgress | null
}

/**
 * The scans worth showing: an agent that has never answered, and a refresh that is reading files. A
 * refresh that finds nothing to read sends no progress and stays out of sight.
 */
export function visibleScans(listings: Listings, inFlight: ReadonlySet<AgentId>, progress: Partial<Record<AgentId, ScanProgress>>): PendingScan[] {
  return AGENT_IDS.filter((agent) => listings[agent] === null || (inFlight.has(agent) && progress[agent])).map((agent) => ({ agent, progress: progress[agent] ?? null }))
}
