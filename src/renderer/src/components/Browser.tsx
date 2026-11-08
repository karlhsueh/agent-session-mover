import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import type { StoreRoot } from '../../../shared/ipc'
import type { SessionKey, SessionList as List } from '../../../shared/sessions'
import { EMPTY_QUERY, isFiltered, visibleSessions, type BrowseQuery } from '../model/browse'
import { AGENT_LABEL, MOD, plural } from '../model/format'
import { focusedKey, NO_SELECTION, selectionReducer } from '../model/selection'
import type { Theme } from '../hooks'
import { Kbd } from './common'
import { Filters } from './Filters'
import { TitleBar } from './TitleBar'
import { SessionDetail } from './SessionDetail'
import { SessionList, type ClickMode } from './SessionList'

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

export function Browser({ list, storeRoots, now, active, onExport, onImport, theme, onToggleTheme, notice }: Props) {
  const [query, setQuery] = useState<BrowseQuery>(EMPTY_QUERY)
  const [selection, dispatch] = useReducer(selectionReducer, NO_SELECTION)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const visible = useMemo(() => visibleSessions(list.sessions, query), [list.sessions, query])
  const order = useMemo(() => visible.map((session) => session.key), [visible])
  const orderRef = useRef(order)
  orderRef.current = order
  const focus = focusedKey(selection, order)
  const focused = visible.find((session) => session.key === focus) ?? null
  const selectedKeys = list.sessions.filter((session) => selection.keys.has(session.key)).map((session) => session.key)
  const hiddenSelected = selectedKeys.filter((key) => !order.includes(key)).length

  useEffect(() => {
    dispatch({ type: 'retain', existing: new Set(list.sessions.map((session) => session.key)) })
  }, [list.sessions])

  useEffect(() => {
    listRef.current?.focus()
  }, [])

  const onClick = useCallback((key: SessionKey, mode: ClickMode) => {
    dispatch({ type: 'click', key, mode, order: orderRef.current })
    listRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!active) return
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
        dispatch({ type: 'move', to, extend: event.shiftKey, order })
      } else if (typing) {
        return
      } else if (mod && key === 'a') {
        event.preventDefault()
        dispatch({ type: 'all', order })
      } else if (event.key === ' ' && onList) {
        event.preventDefault()
        dispatch({ type: 'toggle-focus', order })
      } else if ((event.key === 'Home' || event.key === 'End') && onList) {
        event.preventDefault()
        dispatch({ type: 'move', to: event.key === 'Home' ? 'first' : 'last', extend: event.shiftKey, order })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, order, query, selectedKeys, onExport, onImport])

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

  return (
    <>
      <TitleBar theme={theme} onToggleTheme={onToggleTheme}>
        <Filters sessions={list.sessions} query={query} onChange={setQuery} searchRef={searchRef} />
        <button type="button" className="button" onClick={onImport} title={`Import archive (${MOD}O)`}>
          Import…
        </button>
      </TitleBar>
      {notice}
      <Problems list={list} />
      <div className="browse">
        <div className="list-pane">
          {visible.length > 0 ? (
            <SessionList sessions={visible} selected={selection.keys} focus={focus} now={now} onClick={onClick} listRef={listRef} />
          ) : (
            <div className="empty">
              <p>No sessions match.</p>
              <button type="button" className="button" onClick={() => setQuery({ ...EMPTY_QUERY, sort: query.sort })}>
                Clear filters
              </button>
            </div>
          )}
        </div>
        <SessionDetail session={focused} />
      </div>
      <footer className="statusbar">
        <span className="dim" aria-live="polite">
          {isFiltered(query) ? `${visible.length} of ${plural(list.sessions.length, 'session')}` : plural(list.sessions.length, 'session')}
        </span>
        <span className="hints dim">
          <Kbd>↑↓</Kbd> move <Kbd>Space</Kbd> select <Kbd>{MOD}A</Kbd> all <Kbd>Esc</Kbd> clear
        </span>
        <span className="statusbar-actions">
          {selectedKeys.length > 0 && (
            <span className="selection-count">
              {selectedKeys.length} selected{hiddenSelected > 0 && <span className="dim"> ({hiddenSelected} hidden by filters)</span>}
            </span>
          )}
          <button type="button" className="button primary" disabled={selectedKeys.length === 0} onClick={() => onExport(selectedKeys)}>
            {selectedKeys.length > 0 ? `Export ${plural(selectedKeys.length, 'session')}…` : 'Export…'}
            <Kbd>{MOD}E</Kbd>
          </button>
        </span>
      </footer>
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
