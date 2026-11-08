import { memo, useEffect, type MouseEvent } from 'react'
import type { SessionKey, SessionSummary } from '../../../shared/sessions'
import { absoluteTime, CLIENT_LABEL, folderName, plural, relativeTime, sessionTitle } from '../model/format'
import { AgentMark, Highlight } from './common'

export function rowId(key: SessionKey): string {
  return `row-${encodeURIComponent(key)}`
}

export type ClickMode = 'only' | 'toggle' | 'range'

interface Props {
  sessions: readonly SessionSummary[]
  showProject: boolean
  needle: string
  selected: ReadonlySet<SessionKey>
  focus: SessionKey | null
  now: number
  onClick: (key: SessionKey, mode: ClickMode) => void
  listRef: React.RefObject<HTMLDivElement | null>
}

export function SessionList({ sessions, showProject, needle, selected, focus, now, onClick, listRef }: Props) {
  useEffect(() => {
    if (focus) document.getElementById(rowId(focus))?.scrollIntoView({ block: 'nearest' })
  }, [focus])

  return (
    <div
      ref={listRef}
      className={`list${showProject ? ' with-project' : ''}${selected.size > 0 ? ' has-selection' : ''}`}
      role="listbox"
      aria-label="Sessions"
      aria-multiselectable="true"
      aria-activedescendant={focus ? rowId(focus) : undefined}
      tabIndex={0}
    >
      {sessions.map((session) => (
        <SessionRow
          key={session.key}
          session={session}
          showProject={showProject}
          needle={needle}
          selected={selected.has(session.key)}
          focused={focus === session.key}
          now={now}
          onClick={onClick}
        />
      ))}
    </div>
  )
}

function modeOf(event: MouseEvent): ClickMode {
  if (event.shiftKey) return 'range'
  return event.metaKey || event.ctrlKey ? 'toggle' : 'only'
}

const SessionRow = memo(function SessionRow({
  session,
  showProject,
  needle,
  selected,
  focused,
  now,
  onClick,
}: {
  session: SessionSummary
  showProject: boolean
  needle: string
  selected: boolean
  focused: boolean
  now: number
  onClick: (key: SessionKey, mode: ClickMode) => void
}) {
  const count = session.subagents.length
  return (
    <div
      id={rowId(session.key)}
      role="option"
      aria-selected={selected}
      className={`row${selected ? ' selected' : ''}${focused ? ' focused' : ''}`}
      onMouseDown={(event) => {
        if (event.shiftKey) event.preventDefault()
      }}
      onClick={(event) => onClick(session.key, modeOf(event))}
    >
      <span
        className="check"
        aria-hidden="true"
        onClick={(event) => {
          event.stopPropagation()
          onClick(session.key, event.shiftKey ? 'range' : 'toggle')
        }}
      />
      <AgentMark agent={session.agent} />
      <span className="row-title">
        <span className="truncate">
          <Highlight text={sessionTitle(session)} needle={needle} />
        </span>
        {session.live && <span className="badge live">Live</span>}
        {count > 0 && (
          <span className="subcount" title={`${plural(count, 'subagent')}, listed in the details`}>
            +{count}
          </span>
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
      <time className="row-time" dateTime={session.lastActivity} title={absoluteTime(session.lastActivity)}>
        {relativeTime(session.lastActivity, now)}
      </time>
    </div>
  )
})
