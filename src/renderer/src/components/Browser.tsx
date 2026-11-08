import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import type { StoreRoot } from '../../../shared/ipc'
import type { SessionKey, SessionList as List } from '../../../shared/sessions'
import { EMPTY_QUERY, isFiltered, type BrowseQuery, type Grouping } from '../model/browse'
import { AGENT_LABEL, MOD, plural } from '../model/format'
import { buildView, searchNeedle, type GroupKey } from '../model/rows'
import { focusedKey, NO_SELECTION, selectionReducer } from '../model/selection'
import { useHomeDir, useStored, type Theme } from '../hooks'
import { Kbd } from './common'
import { SessionDetail, type DetailTarget } from './SessionDetail'
import { SessionList, type ListActions } from './SessionList'
import { Shortcuts } from './Shortcuts'
import { TitleBar } from './TitleBar'
import { Toolbar } from './Toolbar'

interface Props {
  list: List
  storeRoots: StoreRoot[]
  now: number
  /** False while a sheet covers the browser, so its shortcuts stay with the sheet. */
  active: boolean
  onExport: (keys: SessionKey[]) => void
  onImport: () => void
  theme: Theme
  onToggleTheme: () => void
  /** An error from the last action, shown under the title bar. */
  notice: ReactNode
}

function inTextField(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
}

const parseGrouping = (raw: string | null): Grouping => (raw === 'flat' ? 'flat' : 'project')
const keepGrouping = (grouping: Grouping) => grouping
function parseCollapsed(raw: string | null): ReadonlySet<GroupKey> {
  const value: unknown = raw ? JSON.parse(raw) : []
  return new Set(Array.isArray(value) ? (value.filter((item) => typeof item === 'string') as GroupKey[]) : [])
}
const keepCollapsed = (collapsed: ReadonlySet<GroupKey>) => JSON.stringify([...collapsed])

export function Browser({ list, storeRoots, now, active, onExport, onImport, theme, onToggleTheme, notice }: Props) {
  const [query, setQueryState] = useState<BrowseQuery>(EMPTY_QUERY)
  const [grouping, setGrouping] = useStored('agent-sessions.grouping', parseGrouping, keepGrouping)
  const [collapsed, setCollapsed] = useStored('agent-sessions.collapsed', parseCollapsed, keepCollapsed)
  const [expanded, setExpanded] = useState<ReadonlyMap<SessionKey, boolean>>(new Map())
  const [selection, dispatch] = useReducer(selectionReducer, NO_SELECTION)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const home = useHomeDir()
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const view = useMemo(() => buildView(list.sessions, { query, grouping, collapsed, expanded }), [list.sessions, query, grouping, collapsed, expanded])
  const rows = view.rows
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const byKey = useMemo(() => new Map(list.sessions.map((session) => [session.key, session])), [list.sessions])
  const focus = focusedKey(selection, rows)
  const focusedRow = rows.find((row) => row.key === focus) ?? null
  const selectedKeys = list.sessions.filter((session) => selection.keys.has(session.key)).map((session) => session.key)
  const matched = new Set(view.matches)
  const hiddenSelected = selectedKeys.filter((key) => !matched.has(key)).length

  useEffect(() => {
    dispatch({ type: 'retain', existing: new Set(list.sessions.map((session) => session.key)) })
  }, [list.sessions])

  useEffect(() => {
    listRef.current?.focus()
  }, [])

  const toggleCollapsed = useCallback(
    (group: GroupKey) =>
      setCollapsed((current) => {
        const next = new Set(current)
        if (!next.delete(group)) next.add(group)
        return next
      }),
    [setCollapsed],
  )
  // A new search expands the sessions it matches through subagents, so earlier folds start over.
  const setQuery = (next: BrowseQuery) => {
    if (next.text !== query.text) setExpanded(new Map())
    setQueryState(next)
  }
  const setSessionOpen = useCallback((key: SessionKey, open: boolean) => setExpanded((current) => new Map(current).set(key, open)), [])

  const actions = useMemo<ListActions>(
    () => ({
      onClick: (key, mode) => {
        dispatch({ type: 'click', key, mode, rows: rowsRef.current })
        listRef.current?.focus()
      },
      onFocusRow: (key) => {
        dispatch({ type: 'focus', key })
        listRef.current?.focus()
      },
      onToggleGroup: (row) => {
        dispatch({ type: 'toggle-group', key: row.key, sessions: row.sessions })
        listRef.current?.focus()
      },
      onCollapseGroup: (row) => toggleCollapsed(row.group),
      onExpandSession: (key) => {
        const row = rowsRef.current.find((candidate) => candidate.key === key)
        if (row?.kind === 'session') setSessionOpen(key, !row.expanded)
      },
    }),
    [toggleCollapsed, setSessionOpen],
  )

  /** Left and Right fold the focused row, or step to its parent or first child, as in a file tree. */
  function fold(direction: 'in' | 'out') {
    const row = focusedRow
    const next = () => dispatch({ type: 'move', to: 'next', extend: false, rows })
    if (!row) return
    if (row.kind === 'group') {
      if (direction === 'in') return row.collapsed ? toggleCollapsed(row.group) : next()
      if (!row.collapsed && !view.searching) toggleCollapsed(row.group)
    } else if (row.kind === 'session') {
      const hasChildren = row.session.subagents.length > 0
      if (direction === 'in') return hasChildren && (row.expanded ? next() : setSessionOpen(row.key, true))
      if (row.expanded) setSessionOpen(row.key, false)
      else if (row.group) dispatch({ type: 'focus', key: row.group })
    } else if (direction === 'out') {
      dispatch({ type: 'focus', key: row.parent })
    }
  }

  useEffect(() => {
    if (!active || showShortcuts) return
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey
      const typing = inTextField(event.target)
      const onList = event.target === listRef.current || event.target === document.body
      const key = event.key.toLowerCase()
      if ((mod && key === 'f') || (!typing && event.key === '/')) {
        event.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      } else if (mod && key === 'e') {
        event.preventDefault()
        if (selectedKeys.length > 0) onExport(selectedKeys)
      } else if (mod && key === 'o') {
        event.preventDefault()
        onImport()
      } else if (event.key === 'Escape') {
        if (event.target === searchRef.current && query.text !== '') setQuery({ ...query, text: '' })
        else if (typing) listRef.current?.focus()
        else dispatch({ type: 'clear' })
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (!onList && event.target !== searchRef.current) return
        event.preventDefault()
        if (typing) listRef.current?.focus()
        const to = event.key === 'ArrowDown' ? (mod ? 'last' : 'next') : mod ? 'first' : 'previous'
        dispatch({ type: 'move', to, extend: event.shiftKey, rows })
      } else if (typing) {
        return
      } else if (event.key === '?') {
        event.preventDefault()
        setShowShortcuts(true)
      } else if (mod && key === 'a') {
        event.preventDefault()
        dispatch({ type: 'all', keys: view.matches })
      } else if (!onList) {
        return
      } else if (event.key === ' ') {
        event.preventDefault()
        dispatch({ type: 'toggle-focus', rows })
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault()
        fold(event.key === 'ArrowRight' ? 'in' : 'out')
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        dispatch({ type: 'move', to: event.key === 'Home' ? 'first' : 'last', extend: event.shiftKey, rows })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (list.sessions.length === 0)
    return (
      <>
        <TitleBar theme={theme} onToggleTheme={onToggleTheme}>
          <span className="app-name">Agent Sessions</span>
        </TitleBar>
        {notice}
        <EmptyStore list={list} storeRoots={storeRoots} onImport={onImport} />
      </>
    )

  const detail: DetailTarget =
    focusedRow?.kind === 'session'
      ? { kind: 'session', session: focusedRow.session, subagent: null }
      : focusedRow?.kind === 'subagent'
        ? { kind: 'session', session: byKey.get(focusedRow.parent)!, subagent: focusedRow.subagent.id }
        : focusedRow?.kind === 'group'
          ? { kind: 'group', row: focusedRow, sessions: focusedRow.sessions.map((key) => byKey.get(key)!) }
          : null

  return (
    <>
      <TitleBar theme={theme} onToggleTheme={onToggleTheme}>
        <Toolbar sessions={list.sessions} query={query} onChange={setQuery} grouping={grouping} onGrouping={(next) => setGrouping(() => next)} searchRef={searchRef} />
      </TitleBar>
      {notice}
      <Problems list={list} />
      <div className="browse">
        <div className="list-pane">
          {rows.length > 0 ? (
            <SessionList
              rows={rows}
              grouped={grouping === 'project'}
              searching={view.searching}
              needle={searchNeedle(query)}
              selected={selection.keys}
              focus={focus}
              now={now}
              home={home}
              actions={actions}
              listRef={listRef}
            />
          ) : (
            <div className="empty">
              <p>No sessions match.</p>
              <button type="button" className="button" onClick={() => setQuery({ ...EMPTY_QUERY, sort: query.sort })}>
                Clear filters
              </button>
            </div>
          )}
        </div>
        <SessionDetail target={detail} home={home} now={now} />
      </div>
      <footer className="statusbar">
        <span className="status" aria-live="polite">
          <span className="dim">
            {isFiltered(query) ? `${view.matches.length} of ${plural(list.sessions.length, 'session')}` : plural(list.sessions.length, 'session')}
            {grouping === 'project' && ` in ${plural(view.groupCount, 'project')}`}
          </span>
          {selectedKeys.length > 0 ? (
            <span className="selection-count">
              {selectedKeys.length} selected
              {hiddenSelected > 0 && <span className="dim"> ({hiddenSelected} hidden by filters)</span>}
              <button type="button" className="button ghost small" onClick={() => dispatch({ type: 'clear' })}>
                Clear
              </button>
            </span>
          ) : (
            <span className="dim">Select sessions to export</span>
          )}
        </span>
        <span className="statusbar-actions">
          <button type="button" className="button ghost icon" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => setShowShortcuts(true)}>
            ?
          </button>
          <button type="button" className="button" onClick={onImport} title={`Import an archive (${MOD}O)`}>
            Import…
          </button>
          <button type="button" className="button primary export" disabled={selectedKeys.length === 0} onClick={() => onExport(selectedKeys)}>
            {selectedKeys.length > 0 ? `Export ${plural(selectedKeys.length, 'session')}…` : 'Export…'}
            <Kbd>{MOD}E</Kbd>
          </button>
        </span>
      </footer>
      {showShortcuts && <Shortcuts onClose={() => setShowShortcuts(false)} />}
    </>
  )
}

function Problems({ list }: { list: List }) {
  if (list.problems.length === 0) return null
  return (
    <div className="banner banner-warn" role="status">
      {list.problems.map((problem) => (
        <div key={problem.agent}>
          <strong>Could not read the {AGENT_LABEL[problem.agent]} store.</strong> <span className="banner-detail">{problem.message}</span>
        </div>
      ))}
    </div>
  )
}

function EmptyStore({ list, storeRoots, onImport }: { list: List; storeRoots: StoreRoot[]; onImport: () => void }) {
  return (
    <div className="empty-store">
      <Problems list={list} />
      <div className="empty-card">
        <h1>No sessions on this machine</h1>
        <p className="dim">Agent Sessions looked for Claude Code and Codex sessions in:</p>
        <ul className="roots">
          {storeRoots.map((root) => (
            <li key={root.agent}>
              <span>{AGENT_LABEL[root.agent]}</span>
              <code>{root.path}</code>
            </li>
          ))}
          {!storeRoots.some((root) => root.agent === 'codex') && (
            <li>
              <span>Codex</span>
              <span className="dim">Not supported in this build</span>
            </li>
          )}
        </ul>
        <p className="dim">
          Set <code>CLAUDE_CONFIG_DIR</code> or <code>CODEX_HOME</code> before launch if your stores live elsewhere. To bring sessions from another machine, open
          an archive.
        </p>
        <button type="button" className="button primary" onClick={onImport}>
          Import archive… <Kbd>{MOD}O</Kbd>
        </button>
      </div>
    </div>
  )
}
