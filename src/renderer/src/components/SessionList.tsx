import { memo, useEffect, type MouseEvent } from 'react'
import type { SessionKey, SessionSummary } from '../../../shared/sessions'
import { AGENT_LABEL, CLIENT_LABEL, folderName, relativeTime, sessionTitle } from '../model/format'

export function rowId(key: SessionKey): string {
  return `session-${key}`
}

export type ClickMode = 'only' | 'toggle' | 'range'

interface Props {
  sessions: SessionSummary[]
  selected: ReadonlySet<SessionKey>
  focus: SessionKey | null
  now: number
  onClick: (key: SessionKey, mode: ClickMode) => void
  listRef: React.RefObject<HTMLDivElement | null>
}

export function SessionList({ sessions, selected, focus, now, onClick, listRef }: Props) {
  useEffect(() => {
    if (focus) document.getElementById(rowId(focus))?.scrollIntoView({ block: 'nearest' })
  }, [focus])

  return (
    <div
      ref={listRef}
      className={selected.size > 0 ? 'list has-selection' : 'list'}
      role="listbox"
      aria-label="Sessions"
      aria-multiselectable="true"
      aria-activedescendant={focus ? rowId(focus) : undefined}
      tabIndex={0}
    >
      {sessions.map((session) => (
        <Row
          key={session.key}
          session={session}
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

const Row = memo(function Row({
  session,
  selected,
  focused,
  now,
  onClick,
}: {
  session: SessionSummary
  selected: boolean
  focused: boolean
  now: number
  onClick: Props['onClick']
}) {
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
      <span className="row-title">
        <span className="truncate">{sessionTitle(session)}</span>
        {session.live && <span className="badge live">Live</span>}
      </span>
      <span className="row-project truncate" title={session.cwd ?? undefined}>
        {folderName(session.cwd)}
      </span>
      <span className="row-agent truncate">
        {AGENT_LABEL[session.agent]} <span className="dim">· {CLIENT_LABEL[session.client]}</span>
      </span>
      <time className="row-time" dateTime={session.lastActivity}>
        {relativeTime(session.lastActivity, now)}
      </time>
    </div>
  )
})
