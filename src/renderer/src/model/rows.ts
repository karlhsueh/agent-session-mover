import type { SessionKey, SessionSummary, SubagentSummary } from '../../../shared/sessions'
import { SORTS, type BrowseQuery, type Grouping } from './browse'
import { folderName, sessionTitle } from './format'

declare const groupKeyBrand: unique symbol
/** A session's starting cwd, or NO_FOLDER when it recorded none. */
export type GroupKey = string & { readonly [groupKeyBrand]: true }

/** Not a path any OS produces, so it cannot collide with a real cwd. */
export const NO_FOLDER = '\u0000no-folder' as GroupKey

export function groupKeyOf(session: Pick<SessionSummary, 'cwd'>): GroupKey {
  return (session.cwd ?? NO_FOLDER) as GroupKey
}

/** Unique across every row kind. A session row's key is its SessionKey. */
export type RowKey = SessionKey | `group:${string}` | `sub:${SessionKey}:${string}`

export type DisplayRow =
  | {
      kind: 'group'
      key: RowKey
      group: GroupKey
      folder: string
      path: string | null
      /** Every session in the group that the filters match, shown or collapsed. */
      sessions: readonly SessionKey[]
      newest: string
      collapsed: boolean
    }
  | { kind: 'session'; key: SessionKey; session: SessionSummary; group: RowKey | null; expanded: boolean }
  | { kind: 'subagent'; key: RowKey; parent: SessionKey; subagent: SubagentSummary }

export interface ViewState {
  query: BrowseQuery
  grouping: Grouping
  collapsed: ReadonlySet<GroupKey>
  /** The user's own expand or collapse of a session. It wins over the default. */
  expanded: ReadonlyMap<SessionKey, boolean>
}

export interface View {
  rows: DisplayRow[]
  /** Every session the filters match, collapsed groups included, in display order. */
  matches: SessionKey[]
  /** A text search ignores collapsed groups, so every hit is on screen. */
  searching: boolean
  groupCount: number
}

interface Hit {
  session: SessionSummary
  /** Subagents whose title matches the search. Null when no text search runs. */
  subagentHits: SubagentSummary[] | null
}

export function groupRowKey(group: GroupKey): RowKey {
  return `group:${group}`
}

export function subagentRowKey(parent: SessionKey, id: string): RowKey {
  return `sub:${parent}:${id}`
}

export function searchNeedle(query: BrowseQuery): string {
  return query.text.trim().toLowerCase()
}

function hits(sessions: readonly SessionSummary[], query: BrowseQuery): Hit[] {
  const needle = searchNeedle(query)
  const has = (value: string | null) => value !== null && value.toLowerCase().includes(needle)
  const found: Hit[] = []
  for (const session of sessions) {
    if (query.agent !== null && session.agent !== query.agent) continue
    if (query.client !== null && session.client !== query.client) continue
    if (needle === '') {
      found.push({ session, subagentHits: null })
      continue
    }
    const subagentHits = session.subagents.filter((subagent) => has(subagent.title))
    if (subagentHits.length > 0 || [sessionTitle(session), session.id, ...session.cwds].some(has)) found.push({ session, subagentHits })
  }
  return found.sort((a, b) => SORTS[query.sort].compare(a.session, b.session))
}

function sessionRows({ session, subagentHits }: Hit, group: RowKey | null, state: ViewState): DisplayRow[] {
  const matchedSubagents = subagentHits !== null && subagentHits.length > 0
  const expanded = session.subagents.length > 0 && (state.expanded.get(session.key) ?? matchedSubagents)
  const rows: DisplayRow[] = [{ kind: 'session', key: session.key, session, group, expanded }]
  if (!expanded) return rows
  for (const subagent of matchedSubagents ? subagentHits : session.subagents) {
    rows.push({ kind: 'subagent', key: subagentRowKey(session.key, subagent.id), parent: session.key, subagent })
  }
  return rows
}

export function buildView(sessions: readonly SessionSummary[], state: ViewState): View {
  const found = hits(sessions, state.query)
  const searching = searchNeedle(state.query) !== ''
  if (state.grouping === 'flat') {
    return { rows: found.flatMap((hit) => sessionRows(hit, null, state)), matches: found.map((hit) => hit.session.key), searching, groupCount: 0 }
  }

  const byGroup = new Map<GroupKey, Hit[]>()
  for (const hit of found) {
    const key = groupKeyOf(hit.session)
    byGroup.set(key, [...(byGroup.get(key) ?? []), hit])
  }
  const groups = [...byGroup].map(([group, members]) => ({
    group,
    members,
    folder: folderName(group === NO_FOLDER ? null : group),
    newest: members.reduce((newest, hit) => (hit.session.lastActivity > newest ? hit.session.lastActivity : newest), ''),
  }))
  groups.sort(
    SORTS[state.query.sort].groupsByName
      ? (a, b) => a.folder.localeCompare(b.folder) || a.group.localeCompare(b.group)
      : (a, b) => b.newest.localeCompare(a.newest),
  )

  const rows: DisplayRow[] = []
  const matches: SessionKey[] = []
  for (const { group, members, folder, newest } of groups) {
    const key = groupRowKey(group)
    const collapsed = !searching && state.collapsed.has(group)
    const keys = members.map((hit) => hit.session.key)
    matches.push(...keys)
    rows.push({ kind: 'group', key, group, folder, path: group === NO_FOLDER ? null : group, sessions: keys, newest, collapsed })
    if (!collapsed) for (const hit of members) rows.push(...sessionRows(hit, key, state))
  }
  return { rows, matches, searching, groupCount: groups.length }
}

/** The sessions a row stands for: Space and the group checkbox select these. Subagents travel with their parent. */
export function rowSessions(row: DisplayRow): readonly SessionKey[] {
  if (row.kind === 'session') return [row.key]
  return row.kind === 'group' ? row.sessions : []
}

export type GroupSelection = 'none' | 'some' | 'all'

export function groupSelection(sessions: readonly SessionKey[], selected: ReadonlySet<SessionKey>): GroupSelection {
  const count = sessions.filter((key) => selected.has(key)).length
  return count === 0 ? 'none' : count === sessions.length ? 'all' : 'some'
}

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
