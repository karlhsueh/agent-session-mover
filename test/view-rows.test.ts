import { describe, expect, it } from 'vitest'
import { sessionKey, type SessionKey, type SessionSummary, type SubagentSummary } from '../src/shared/sessions'
import { EMPTY_QUERY, type BrowseQuery, type Grouping } from '../src/renderer/src/model/browse'
import { buildView, groupSelection, matchParts, NO_FOLDER, type DisplayRow, type GroupKey } from '../src/renderer/src/model/rows'
import { NO_SELECTION, selectionReducer, type Selection } from '../src/renderer/src/model/selection'

function session(id: string, cwd: string | null, title: string, day: number, subagents: string[] = []): SessionSummary {
  const lastActivity = `2026-11-${String(day).padStart(2, '0')}T10:00:00.000Z`
  return {
    key: sessionKey('claude-code', id),
    agent: 'claude-code',
    id,
    client: 'cli',
    clientDetail: 'cli',
    title,
    cwd,
    cwds: cwd ? [cwd] : [],
    createdAt: lastActivity,
    lastActivity,
    cliVersion: null,
    sizeBytes: 1,
    fileCount: 1,
    live: false,
    archived: false,
    hiddenFromPicker: false,
    subagents: subagents.map((title, index): SubagentSummary => ({ id: `a${index}`, title, role: 'Explore', lastActivity })),
    resumeCommand: '',
  }
}

const sessions = [
  session('s1', '/u/code/api', 'Fix retry', 5),
  session('s2', '/u/code/api', 'Add pagination', 9, ['Find the router', 'Write the migration']),
  session('s3', '/u/code/web', 'Hydration warning', 7),
  session('s4', null, 'Scratch notes', 1),
]
const key = (id: string): SessionKey => sessionKey('claude-code', id)

function view(options: { query?: Partial<BrowseQuery>; grouping?: Grouping; collapsed?: string[]; expanded?: [string, boolean][] } = {}) {
  return buildView(sessions, {
    query: { ...EMPTY_QUERY, ...options.query },
    grouping: options.grouping ?? 'project',
    collapsed: new Set((options.collapsed ?? []) as GroupKey[]),
    expanded: new Map((options.expanded ?? []).map(([id, open]) => [key(id), open])),
  })
}

const outline = (rows: DisplayRow[]) =>
  rows.map((row) => (row.kind === 'group' ? `# ${row.folder} ${row.sessions.length}` : row.kind === 'session' ? row.session.title : `  - ${row.subagent.title}`))

describe('session list view', () => {
  it('groups sessions by folder, newest group first, newest session first inside', () => {
    expect(outline(view().rows)).toEqual(['# api 2', 'Add pagination', 'Fix retry', '# web 1', 'Hydration warning', '# No folder 1', 'Scratch notes'])
  })

  it('orders groups by name when sorting by title, and sessions by title inside', () => {
    expect(outline(view({ query: { sort: 'title' } }).rows)).toEqual(['# api 2', 'Add pagination', 'Fix retry', '# No folder 1', 'Scratch notes', '# web 1', 'Hydration warning'])
  })

  it('hides a collapsed group’s sessions but keeps them in the matches', () => {
    const result = view({ collapsed: ['/u/code/api'] })
    expect(outline(result.rows)).toEqual(['# api 2', '# web 1', 'Hydration warning', '# No folder 1', 'Scratch notes'])
    expect(result.matches).toEqual([key('s2'), key('s1'), key('s3'), key('s4')])
  })

  it('shows subagents only when their parent is expanded', () => {
    expect(outline(view({ expanded: [['s2', true]] }).rows).slice(0, 4)).toEqual(['# api 2', 'Add pagination', '  - Find the router', '  - Write the migration'])
  })

  it('finds a parent through a subagent title, expanded to the matching subagent, even in a collapsed group', () => {
    expect(outline(view({ query: { text: 'MIGRATION' }, collapsed: ['/u/code/api'] }).rows)).toEqual(['# api 1', 'Add pagination', '  - Write the migration'])
    expect(outline(view({ query: { text: 'migration' }, expanded: [['s2', false]] }).rows)).toEqual(['# api 1', 'Add pagination'])
  })

  it('matches folders and ids, and filters by agent', () => {
    expect(outline(view({ query: { text: 'code/web' } }).rows)).toEqual(['# web 1', 'Hydration warning'])
    expect(outline(view({ query: { text: 's4' } }).rows)).toEqual(['# No folder 1', 'Scratch notes'])
    expect(view({ query: { agent: 'codex' } }).rows).toEqual([])
  })

  it('lists sessions without headers in flat mode', () => {
    expect(outline(view({ grouping: 'flat' }).rows)).toEqual(['Add pagination', 'Hydration warning', 'Fix retry', 'Scratch notes'])
  })

  it('keys the folderless group apart from any real path', () => {
    const group = view().rows.find((row) => row.kind === 'group' && row.folder === 'No folder')
    expect(group).toMatchObject({ group: NO_FOLDER, path: null })
  })
})

describe('selection over grouped rows', () => {
  const rows = view().rows
  const apply = (...actions: Parameters<typeof selectionReducer>[1][]) => actions.reduce<Selection>(selectionReducer, NO_SELECTION)

  it('Space on a group header selects its sessions, and again clears them', () => {
    const once = apply({ type: 'focus', key: 'group:/u/code/api' }, { type: 'toggle-focus', rows })
    expect([...once.keys]).toEqual([key('s2'), key('s1')])
    expect(groupSelection([key('s2'), key('s1')], once.keys)).toBe('all')
    expect(selectionReducer(once, { type: 'toggle-focus', rows }).keys.size).toBe(0)
  })

  it('a partly selected group reads as some, and its checkbox completes it', () => {
    const partial = apply({ type: 'click', key: key('s1'), mode: 'only', rows })
    expect(groupSelection([key('s2'), key('s1')], partial.keys)).toBe('some')
    expect([...selectionReducer(partial, { type: 'toggle-group', key: 'group:/u/code/api', sessions: [key('s2'), key('s1')] }).keys].sort()).toEqual([key('s1'), key('s2')])
  })

  it('a shift range across a header selects only the sessions in between', () => {
    const ranged = apply({ type: 'click', key: key('s1'), mode: 'only', rows }, { type: 'move', to: 'next', extend: true, rows }, { type: 'move', to: 'next', extend: true, rows })
    expect([...ranged.keys]).toEqual([key('s1'), key('s3')])
  })

  it('arrow keys visit headers, sessions, and subagent rows in order', () => {
    const expandedRows = view({ expanded: [['s2', true]] }).rows
    const steps = [0, 1, 2, 3].reduce<Selection[]>((states, _) => [...states, selectionReducer(states.at(-1)!, { type: 'move', to: 'next', extend: false, rows: expandedRows })], [
      apply({ type: 'focus', key: 'group:/u/code/api' }),
    ])
    expect(steps.map((state) => state.focus)).toEqual(['group:/u/code/api', key('s2'), `sub:${key('s2')}:a0`, `sub:${key('s2')}:a1`, key('s1')])
  })
})

describe('search highlight', () => {
  it('splits every case-insensitive match', () => {
    expect(matchParts('Retry the retry', 'retry')).toEqual([
      { text: 'Retry', match: true },
      { text: ' the ', match: false },
      { text: 'retry', match: true },
    ])
  })
})
