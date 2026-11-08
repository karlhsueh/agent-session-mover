import { memo, useEffect, type MouseEvent } from 'react'
import type { SessionKey } from '../../../shared/sessions'
import { absoluteTime, CLIENT_LABEL, folderName, plural, relativeTime, sessionTitle, tildePath } from '../model/format'
import { groupSelection, type DisplayRow, type GroupSelection, type RowKey } from '../model/rows'
import { AgentMark, Highlight } from './common'

export function rowId(key: RowKey): string {
  return `row-${encodeURIComponent(key)}`
}

export type ClickMode = 'only' | 'toggle' | 'range'

export interface ListActions {
  onClick: (key: SessionKey, mode: ClickMode) => void
  onFocusRow: (key: RowKey) => void
  onToggleGroup: (row: Extract<DisplayRow, { kind: 'group' }>) => void
  onCollapseGroup: (row: Extract<DisplayRow, { kind: 'group' }>) => void
  onExpandSession: (key: SessionKey) => void
}

interface Props {
  rows: DisplayRow[]
  grouped: boolean
  /** A text search keeps every group open, so the chevrons rest. */
  searching: boolean
  needle: string
  selected: ReadonlySet<SessionKey>
  focus: RowKey | null
  now: number
  home: string
  actions: ListActions
  listRef: React.RefObject<HTMLDivElement | null>
}

export function SessionList({ rows, grouped, searching, needle, selected, focus, now, home, actions, listRef }: Props) {
  useEffect(() => {
    if (focus) document.getElementById(rowId(focus))?.scrollIntoView({ block: 'nearest' })
  }, [focus])

  const level = grouped ? 1 : 0
  return (
    <div
      ref={listRef}
      className={`list ${grouped ? 'grouped' : 'flat'}${selected.size > 0 ? ' has-selection' : ''}`}
      role="tree"
      aria-label="Sessions"
      aria-multiselectable="true"
      aria-activedescendant={focus ? rowId(focus) : undefined}
      tabIndex={0}
    >
      {rows.map((row) =>
        row.kind === 'group' ? (
          <GroupRow
            key={row.key}
            row={row}
            state={groupSelection(row.sessions, selected)}
            focused={focus === row.key}
            searching={searching}
            now={now}
            home={home}
            actions={actions}
          />
        ) : row.kind === 'session' ? (
          <SessionRow
            key={row.key}
            row={row}
            level={level + 1}
            showProject={!grouped}
            needle={needle}
            selected={selected.has(row.key)}
            focused={focus === row.key}
            now={now}
            actions={actions}
          />
        ) : (
          <SubagentRow key={row.key} row={row} level={level + 2} needle={needle} focused={focus === row.key} now={now} actions={actions} />
        ),
      )}
    </div>
  )
}

function modeOf(event: MouseEvent): ClickMode {
  if (event.shiftKey) return 'range'
  return event.metaKey || event.ctrlKey ? 'toggle' : 'only'
}

const CHECKED: Record<GroupSelection, 'true' | 'false' | 'mixed'> = { all: 'true', some: 'mixed', none: 'false' }

function Time({ iso, now }: { iso: string; now: number }) {
  return (
    <time className="row-time" dateTime={iso} title={absoluteTime(iso)}>
      {relativeTime(iso, now)}
    </time>
  )
}

const GroupRow = memo(function GroupRow({
  row,
  state,
  focused,
  searching,
  now,
  home,
  actions,
}: {
  row: Extract<DisplayRow, { kind: 'group' }>
  state: GroupSelection
  focused: boolean
  searching: boolean
  now: number
  home: string
  actions: ListActions
}) {
  return (
    <div
      id={rowId(row.key)}
      role="treeitem"
      aria-level={1}
      aria-expanded={!row.collapsed}
      aria-label={`${row.folder}, ${plural(row.sessions.length, 'session')}`}
      className={`group-row${focused ? ' focused' : ''}${state !== 'none' ? ' has-selected' : ''}`}
      onClick={() => actions.onFocusRow(row.key)}
    >
      <button
        type="button"
        className="chevron"
        tabIndex={-1}
        disabled={searching}
        aria-label={row.collapsed ? `Expand ${row.folder}` : `Collapse ${row.folder}`}
        onClick={(event) => {
          event.stopPropagation()
          actions.onCollapseGroup(row)
        }}
      />
      <span
        className={`check tri-${state}`}
        role="checkbox"
        aria-checked={CHECKED[state]}
        aria-label={`Select every session in ${row.folder}`}
        onClick={(event) => {
          event.stopPropagation()
          actions.onToggleGroup(row)
        }}
      />
      <span className="group-name">
        <strong className="truncate">{row.folder}</strong>
        {row.path && <span className="group-path truncate">{tildePath(row.path, home)}</span>}
      </span>
      <span className="group-count">{row.sessions.length}</span>
      {row.collapsed ? <Time iso={row.newest} now={now} /> : <span />}
    </div>
  )
})

const SessionRow = memo(function SessionRow({
  row,
  level,
  showProject,
  needle,
  selected,
  focused,
  now,
  actions,
}: {
  row: Extract<DisplayRow, { kind: 'session' }>
  level: number
  showProject: boolean
  needle: string
  selected: boolean
  focused: boolean
  now: number
  actions: ListActions
}) {
  const { session } = row
  const count = session.subagents.length
  return (
    <div
      id={rowId(row.key)}
      role="treeitem"
      aria-level={level}
      aria-selected={selected}
      aria-expanded={count > 0 ? row.expanded : undefined}
      className={`row${selected ? ' selected' : ''}${focused ? ' focused' : ''}`}
      onMouseDown={(event) => {
        if (event.shiftKey) event.preventDefault()
      }}
      onClick={(event) => actions.onClick(row.key, modeOf(event))}
    >
      <span
        className="check"
        aria-hidden="true"
        onClick={(event) => {
          event.stopPropagation()
          actions.onClick(row.key, event.shiftKey ? 'range' : 'toggle')
        }}
      />
      <AgentMark agent={session.agent} />
      <span className="row-title">
        <span className="truncate">
          <Highlight text={sessionTitle(session)} needle={needle} />
        </span>
        {session.live && <span className="badge live">Live</span>}
        {count > 0 && (
          <button
            type="button"
            className="subcount"
            tabIndex={-1}
            aria-expanded={row.expanded}
            aria-label={`${row.expanded ? 'Hide' : 'Show'} ${plural(count, 'subagent')}`}
            title={plural(count, 'subagent')}
            onClick={(event) => {
              event.stopPropagation()
              actions.onExpandSession(row.key)
            }}
          >
            +{count}
          </button>
        )}
      </span>
      {showProject && (
        <span className="row-project truncate" title={session.cwd ?? undefined}>
          {folderName(session.cwd)}
        </span>
      )}
      <span className="row-client truncate" title={session.clientDetail || undefined}>
        {CLIENT_LABEL[session.client]}
      </span>
      <Time iso={session.lastActivity} now={now} />
    </div>
  )
})

const SubagentRow = memo(function SubagentRow({
  row,
  level,
  needle,
  focused,
  now,
  actions,
}: {
  row: Extract<DisplayRow, { kind: 'subagent' }>
  level: number
  needle: string
  focused: boolean
  now: number
  actions: ListActions
}) {
  const { subagent } = row
  return (
    <div id={rowId(row.key)} role="treeitem" aria-level={level} className={`sub-row${focused ? ' focused' : ''}`} onClick={() => actions.onFocusRow(row.key)}>
      <span className="sub-role truncate">{subagent.role ?? 'Agent'}</span>
      <span className="sub-title truncate">
        <Highlight text={subagent.title ?? `Agent ${subagent.id}`} needle={needle} />
      </span>
      {subagent.lastActivity ? <Time iso={subagent.lastActivity} now={now} /> : <span />}
    </div>
  )
})
