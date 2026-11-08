import { describe, expect, it } from 'vitest'
import { sessionKey, type SessionKey, type SessionSummary, type SubagentSummary } from '../src/shared/sessions'
import { EMPTY_QUERY, type BrowseQuery } from '../src/renderer/src/model/browse'
import { matchParts, matchSessions } from '../src/renderer/src/model/rows'
import { countByProject, inScope, NO_FOLDER, projectsOf, type ProjectKey } from '../src/renderer/src/model/scope'
import { NO_SELECTION, selectionReducer, type Selection, type SelectionAction } from '../src/renderer/src/model/selection'

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
const titles = (query: Partial<BrowseQuery> = {}) => matchSessions(sessions, { ...EMPTY_QUERY, ...query }).map((found) => found.title)

describe('matching sessions', () => {
  it('lists every session newest first, or by title', () => {
    expect(titles()).toEqual(['Add pagination', 'Hydration warning', 'Fix retry', 'Scratch notes'])
    expect(titles({ sort: 'title' })).toEqual(['Add pagination', 'Fix retry', 'Hydration warning', 'Scratch notes'])
  })

  it('finds a parent through a subagent title, and matches folders and ids', () => {
    expect(titles({ text: 'MIGRATION' })).toEqual(['Add pagination'])
    expect(titles({ text: 'code/web' })).toEqual(['Hydration warning'])
    expect(titles({ text: 's4' })).toEqual(['Scratch notes'])
    expect(titles({ agent: 'codex' })).toEqual([])
  })
})

describe('project scopes', () => {
  const store = [...sessions, session('s5', '/u/work/api', 'Trace the 502s', 8), { ...session('s6', '/u/code/web', 'Live one', 2), live: true }]

  it('lists one project per folder, newest activity first, with every session counted', () => {
    expect(projectsOf(store).map((project) => [project.name, project.sessions.length])).toEqual([
      ['api', 2],
      ['api', 1],
      ['web', 2],
      ['No folder', 1],
    ])
  })

  it('names the parent folder only when two projects share a name', () => {
    expect(projectsOf(store).map((project) => project.parent)).toEqual(['code', 'work', null, null])
  })

  it('marks a project live when any of its sessions is live', () => {
    expect(projectsOf(store).filter((project) => project.live).map((project) => project.path)).toEqual(['/u/code/web'])
  })

  it('keys a folderless session apart from any real path', () => {
    const scope = { kind: 'project', key: NO_FOLDER } as const
    expect(store.filter((each) => inScope(each, scope)).map((each) => each.title)).toEqual(['Scratch notes'])
    expect(store.filter((each) => inScope(each, { kind: 'all' }))).toHaveLength(store.length)
  })

  it('counts matches per project, so a search can show where its hits are', () => {
    const counts = countByProject(matchSessions(store, { ...EMPTY_QUERY, text: 'tr' }))
    expect(Object.fromEntries(counts)).toEqual({ ['/u/code/api' as ProjectKey]: 1, ['/u/work/api' as ProjectKey]: 1 })
  })
})

describe('selection', () => {
  const rows = [key('s2'), key('s3'), key('s1'), key('s4')]
  const apply = (...actions: SelectionAction[]) => actions.reduce<Selection>(selectionReducer, NO_SELECTION)

  it('Space toggles the focused row, and arrows move the focus', () => {
    const state = apply({ type: 'toggle-focus', rows }, { type: 'move', to: 'next', extend: false, rows }, { type: 'move', to: 'next', extend: false, rows }, { type: 'toggle-focus', rows })
    expect([...state.keys]).toEqual([key('s2'), key('s1')])
    expect([...selectionReducer(state, { type: 'toggle-focus', rows }).keys]).toEqual([key('s2')])
  })

  it('shift-arrow selects the range from the anchor', () => {
    const state = apply({ type: 'click', key: key('s3'), mode: 'only', rows }, { type: 'move', to: 'next', extend: true, rows }, { type: 'move', to: 'next', extend: true, rows })
    expect([...state.keys]).toEqual([key('s3'), key('s1'), key('s4')])
  })

  it('select all adds the shown rows to what is already selected', () => {
    const state = apply({ type: 'click', key: key('s4'), mode: 'only', rows }, { type: 'all', keys: [key('s2'), key('s1')] })
    expect([...state.keys].sort()).toEqual([key('s1'), key('s2'), key('s4')])
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
