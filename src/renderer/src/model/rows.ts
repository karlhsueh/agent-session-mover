import type { SessionSummary } from '../../../shared/sessions'
import { SORTS, type BrowseQuery } from './browse'
import { sessionTitle } from './format'

export function searchNeedle(query: BrowseQuery): string {
  return query.text.trim().toLowerCase()
}

/** Sessions the search and filters match, in sort order. A subagent title match finds its parent. */
export function matchSessions(sessions: readonly SessionSummary[], query: BrowseQuery): SessionSummary[] {
  const needle = searchNeedle(query)
  const has = (value: string | null) => value !== null && value.toLowerCase().includes(needle)
  // Either slash finds a folder, so `code/web` matches a Windows path too.
  const folderNeedle = slashes(needle)
  const hasFolder = (cwd: string) => slashes(cwd.toLowerCase()).includes(folderNeedle)
  return sessions
    .filter(
      (session) =>
        (query.agent === null || session.agent === query.agent) &&
        (query.client === null || session.client === query.client) &&
        (needle === '' || has(sessionTitle(session)) || has(session.id) || session.cwds.some(hasFolder) || session.subagents.some((subagent) => has(subagent.title))),
    )
    .sort(SORTS[query.sort].compare)
}

const slashes = (text: string) => text.replace(/\\/g, '/')

/** Splits text around case-insensitive matches of the needle, for highlighting. */
export function matchParts(text: string, needle: string): { text: string; match: boolean }[] {
  if (needle === '') return [{ text, match: false }]
  const parts: { text: string; match: boolean }[] = []
  const lower = text.toLowerCase()
  let from = 0
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, from)) {
    if (at > from) parts.push({ text: text.slice(from, at), match: false })
    parts.push({ text: text.slice(at, at + needle.length), match: true })
    from = at + needle.length
  }
  if (from < text.length) parts.push({ text: text.slice(from), match: false })
  return parts
}
