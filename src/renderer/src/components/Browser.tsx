import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import type { StoreRoot } from '../../../shared/ipc'
import type { ExportResult, SessionKey, SessionList as List } from '../../../shared/sessions'
import { EMPTY_QUERY, isFiltered, type BrowseQuery } from '../model/browse'
import { MOD, plural, tildePath } from '../model/format'
import type { PendingScan } from '../model/listing'
import { matchSessions, searchNeedle } from '../model/rows'
import { ALL, countByProject, inScope, projectsOf, type Scope } from '../model/scope'
import { focusedKey, NO_SELECTION, selectionReducer } from '../model/selection'
import { useHomeDir, usePreviews, useStored, useUpdateStatus, type Theme } from '../hooks'
import { Kbd, RefreshButton } from './common'
import { ScanLine } from './ScanStatus'
import { EmptyStore, Problems } from './EmptyStore'
import { type DetailTab, parseDetailTab, SessionDetail } from './SessionDetail'
import { SessionList, type ClickMode } from './SessionList'
import { Shortcuts } from './Shortcuts'
import { Sidebar } from './Sidebar'
import { SidebarIcon, TitleBar } from './TitleBar'
import { Toolbar } from './Toolbar'

interface Props {
  list: List
  /** Set while an import screen covers the browser. It stays mounted so its state survives. */
  hidden: boolean
  /** Agents still reading, shown as a slim line in the status bar. */
  scans: PendingScan[]
  refreshing: boolean
  onRefresh: () => void
  storeRoots: StoreRoot[]
  now: number
  /** False while a sheet covers the browser, so its shortcuts stay with the sheet. */
  active: boolean
  onExport: (keys: SessionKey[]) => void
  /** Each new saved export clears the selection, so the next export starts empty. */
  lastExport: ExportResult | null
  onImport: () => void
  theme: Theme
  onToggleTheme: () => void
  /** An error from the last action, shown under the title bar. */
  notice: ReactNode
}

function inTextField(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
}

const parseOpen = (raw: string | null) => raw !== 'false'
const keepOpen = (open: boolean) => String(open)
const keepTab = (tab: DetailTab) => tab
const loadPreview = (key: SessionKey) => window.api.previewSession(key)

export function Browser({ list, hidden, scans, refreshing, onRefresh, storeRoots, now, active, onExport, lastExport, onImport, theme, onToggleTheme, notice }: Props) {
  const [query, setQuery] = useState<BrowseQuery>(EMPTY_QUERY)
  const [wantedScope, setScope] = useState<Scope>(ALL)
  const [sidebarPreferred, setSidebarPreferred] = useStored('agent-sessions.sidebar', parseOpen, keepOpen)
  // A one-project store has nothing to scope, so the sidebar starts hidden and the stored choice is left alone.
  const [singleSidebar, setSingleSidebar] = useState(false)
  const [selection, dispatch] = useReducer(selectionReducer, NO_SELECTION)
  const [showShortcuts, setShowShortcuts] = useState(false)
  // Export with nothing selected points at the hint for a moment instead of doing nothing.
  const [nudge, setNudge] = useState(false)
  // Conversation text stays off screen until the viewer asks for it once.
  const [detailTab, setDetailTab] = useStored('agent-sessions.detail-tab', parseDetailTab, keepTab)
  const versions = useMemo(() => new Map(list.sessions.map((session) => [session.key, `${session.lastActivity} ${session.sizeBytes}`])), [list.sessions])
  const [preview, requestPreview] = usePreviews(loadPreview, 'store', useCallback((key: SessionKey) => versions.get(key) ?? '', [versions]))
  const home = useHomeDir()
  const update = useUpdateStatus()
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)

  const projects = useMemo(() => projectsOf(list.sessions), [list.sessions])
  const showAgent = useMemo(() => new Set(list.sessions.map((session) => session.agent)).size > 1, [list.sessions])
  const projectByKey = useMemo(() => new Map(projects.map((each) => [each.key, each])), [projects])
  const single = projects.length === 1 ? projects[0]! : null
  const sidebarOpen = single ? singleSidebar : sidebarPreferred
  const toggleSidebar = () => (single ? setSingleSidebar((open) => !open) : setSidebarPreferred((open) => !open))
  const project = wantedScope.kind === 'project' ? (projectByKey.get(wantedScope.key) ?? null) : null
  const scope: Scope = project ? wantedScope : ALL
  const filtered = isFiltered(query)
  const matches = useMemo(() => matchSessions(list.sessions, query), [list.sessions, query])
  const shown = useMemo(() => matches.filter((session) => inScope(session, scope)), [matches, scope])
  const rows = useMemo(() => shown.map((session) => session.key), [shown])
  const matchCounts = useMemo(() => (filtered ? countByProject(matches) : null), [filtered, matches])
  const selectedCounts = useMemo(() => countByProject(list.sessions.filter((session) => selection.keys.has(session.key))), [list.sessions, selection.keys])
  const focus = focusedKey(selection, rows)
  const focused = shown.find((session) => session.key === focus) ?? null
  const selectedKeys = list.sessions.filter((session) => selection.keys.has(session.key)).map((session) => session.key)
  const outOfView = selectedKeys.filter((key) => !rows.includes(key)).length
  const scopeTotal = project ? project.sessions.length : list.sessions.length
  const headProject = project ?? single

  useEffect(() => {
    dispatch({ type: 'retain', existing: new Set(list.sessions.map((session) => session.key)) })
  }, [list.sessions])

  useEffect(() => {
    if (lastExport) dispatch({ type: 'clear' })
  }, [lastExport])

  useEffect(() => {
    if (!hidden) listRef.current?.focus()
  }, [hidden])

  useEffect(() => {
    if (!nudge) return
    const timer = setTimeout(() => setNudge(false), 2400)
    return () => clearTimeout(timer)
  }, [nudge])

  const onClick = (key: SessionKey, mode: ClickMode) => {
    dispatch({ type: 'click', key, mode, rows })
    listRef.current?.focus()
  }

  const scopes: Scope[] = [ALL, ...projects.map((each): Scope => ({ kind: 'project', key: each.key }))]
  function moveScope(to: 'next' | 'previous' | 'first' | 'last') {
    const index = scope.kind === 'all' ? 0 : scopes.findIndex((each) => each.kind === 'project' && each.key === scope.key)
    const last = scopes.length - 1
    setScope(scopes[{ first: 0, last, next: Math.min(index + 1, last), previous: Math.max(index - 1, 0) }[to]]!)
  }

  useEffect(() => {
    if (!active || showShortcuts) return
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey
      const typing = inTextField(event.target)
      const onSidebar = event.target === sidebarRef.current
      const onList = event.target === listRef.current || event.target === document.body
      const key = event.key.toLowerCase()
      if ((mod && key === 'f') || (!typing && event.key === '/')) {
        event.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      } else if (mod && key === 'e') {
        event.preventDefault()
        if (selectedKeys.length > 0) onExport(selectedKeys)
        else setNudge(true)
      } else if (mod && key === 'o') {
        event.preventDefault()
        onImport()
      } else if (mod && key === 'r' && !event.shiftKey) {
        event.preventDefault()
        onRefresh()
      } else if (mod && event.key === '\\') {
        event.preventDefault()
        if (sidebarOpen && onSidebar) listRef.current?.focus()
        toggleSidebar()
      } else if (event.key === 'Escape') {
        if (query.text !== '' && (event.target === searchRef.current || !typing)) setQuery({ ...query, text: '' })
        else if (typing) listRef.current?.focus()
        else dispatch({ type: 'clear' })
      } else if (onSidebar && (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End')) {
        event.preventDefault()
        const down = event.key === 'ArrowDown' || event.key === 'End'
        const jump = mod || event.key === 'Home' || event.key === 'End'
        moveScope(down ? (jump ? 'last' : 'next') : jump ? 'first' : 'previous')
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
        dispatch({ type: 'all', keys: rows })
      } else if (onSidebar && (event.key === 'ArrowRight' || event.key === 'Enter')) {
        event.preventDefault()
        listRef.current?.focus()
      } else if (!onList) {
        return
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        if (sidebarOpen) sidebarRef.current?.focus()
      } else if (event.key === ' ') {
        event.preventDefault()
        dispatch({ type: 'toggle-focus', rows })
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
      <div className="browser-host" hidden={hidden} inert={hidden}>
        <TitleBar theme={theme} onToggleTheme={onToggleTheme}>
          <span className="app-name">Agent Session Mover</span>
          <RefreshButton refreshing={refreshing} onRefresh={onRefresh} />
        </TitleBar>
        {notice}
        <EmptyStore list={list} storeRoots={storeRoots} onImport={onImport} />
      </div>
    )

  const otherMatches = matches.length - shown.length
  return (
    <div className="browser-host" hidden={hidden} inert={hidden}>
      <TitleBar theme={theme} onToggleTheme={onToggleTheme}>
        <button
          type="button"
          className="button ghost icon"
          aria-label={sidebarOpen ? 'Hide projects' : 'Show projects'}
          aria-pressed={sidebarOpen}
          title={`${sidebarOpen ? 'Hide' : 'Show'} projects (${MOD}\\)`}
          onClick={toggleSidebar}
        >
          <SidebarIcon />
        </button>
        <Toolbar sessions={list.sessions} query={query} onChange={setQuery} searchRef={searchRef} />
        <RefreshButton refreshing={refreshing} onRefresh={onRefresh} />
      </TitleBar>
      {notice}
      <Problems list={list} />
      <div className={sidebarOpen ? 'browse with-sidebar' : 'browse'}>
        {sidebarOpen && (
          <Sidebar
            projects={projects}
            scope={scope}
            total={list.sessions.length}
            matches={matchCounts}
            matchTotal={matches.length}
            selected={selectedCounts}
            selectedTotal={selectedKeys.length}
            home={home}
            onScope={(next) => {
              setScope(next)
              sidebarRef.current?.focus()
            }}
            sidebarRef={sidebarRef}
          />
        )}
        <div className="list-pane">
          <header className="list-head">
            <span className="list-head-title truncate" title={headProject?.path ?? undefined}>
              {headProject ? (headProject.path ? tildePath(headProject.path, home) : 'No folder') : 'All sessions'}
            </span>
            <span className="list-head-count" title={plural(scopeTotal, 'session')}>
              {filtered ? `${shown.length} of ${scopeTotal}` : scopeTotal}
            </span>
          </header>
          {shown.length > 0 ? (
            <SessionList
              sessions={shown}
              projects={scope.kind === 'all' && !single ? projectByKey : null}
              needle={searchNeedle(query)}
              showAgent={showAgent}
              selected={selection.keys}
              focus={focus}
              now={now}
              onClick={onClick}
              listRef={listRef}
            />
          ) : (
            <div className="empty" ref={listRef} tabIndex={-1}>
              <p>{project ? `No sessions in ${project.name} match.` : 'No sessions match.'}</p>
              {otherMatches > 0 ? (
                <button type="button" className="button" onClick={() => setScope(ALL)}>
                  Show {plural(otherMatches, 'match', 'matches')} in all projects
                </button>
              ) : (
                <button type="button" className="button" onClick={() => setQuery({ ...EMPTY_QUERY, sort: query.sort })}>
                  Clear filters
                </button>
              )}
            </div>
          )}
        </div>
        <SessionDetail
          session={focused}
          home={home}
          now={now}
          tab={detailTab}
          onTab={(tab) => setDetailTab(() => tab)}
          preview={preview}
          onPreview={requestPreview}
        />
      </div>
      <footer className="statusbar">
        <span className="status">
          <ScanLine scans={scans} />
          <span className="dim">{filtered ? `${matches.length} of ${plural(list.sessions.length, 'session')}` : plural(list.sessions.length, 'session')}</span>
          {/* Only the selection is announced. The match count would speak on every keystroke in the search field. */}
          <span className="status" aria-live="polite">
            {selectedKeys.length > 0 ? (
              <span className="selection-count">
                {selectedKeys.length} selected
                {outOfView > 0 && <span className="dim"> ({outOfView} not in this view)</span>}
                <button type="button" className="button ghost small" onClick={() => dispatch({ type: 'clear' })}>
                  Clear
                </button>
              </span>
            ) : (
              <span className={nudge ? 'hint nudge' : 'hint dim'}>{nudge ? 'Nothing selected. Tick sessions to export, or press Space' : 'Tick sessions to export, or press Space'}</span>
            )}
          </span>
        </span>
        <span className="statusbar-actions">
          {update.kind === 'available' && (
            <button type="button" className="button small" onClick={() => void window.api.downloadUpdate()}>
              Update to {update.version}
            </button>
          )}
          {update.kind === 'downloading' && (
            <span className="dim">
              Downloading {update.version}… {update.percent}%
            </span>
          )}
          {update.kind === 'ready' && (
            <button type="button" className="button small" onClick={() => void window.api.installUpdate()}>
              Restart to update to {update.version}
            </button>
          )}
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
    </div>
  )
}
