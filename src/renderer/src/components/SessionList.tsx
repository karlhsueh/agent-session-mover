import { memo, useEffect, type MouseEvent } from 'react'
import type { SessionKey, SessionSummary } from '../../../shared/sessions'
import { absoluteTime, CLIENT_LABEL, plural, relativeTime, sessionTitle } from '../model/format'
import { projectKeyOf, type Project, type ProjectKey } from '../model/scope'
import { AgentMark, Highlight } from './common'

export function rowId(key: SessionKey): string {
  return `row-${encodeURIComponent(key)}`
}

/** A plain click only previews. The checkbox, Cmd/Ctrl-click, and Shift-click change the selection. */
export type ClickMode = 'focus' | 'toggle' | 'check' | 'range'

interface Props {
  sessions: readonly SessionSummary[]
  /** Set in the All scope, where each row names its project. */
  projects: ReadonlyMap<ProjectKey, Project> | null
  needle: string
  /** Off when every session comes from one agent, where the mark tells nothing apart. */
  showAgent: boolean
  selected: ReadonlySet<SessionKey>
  focus: SessionKey | null
  now: number
  onClick: (key: SessionKey, mode: ClickMode) => void
  listRef: React.RefObject<HTMLDivElement | null>
}

export function SessionList({ sessions, projects, needle, showAgent, selected, focus, now, onClick, listRef }: Props) {
  useEffect(() => {
    if (focus) document.getElementById(rowId(focus))?.scrollIntoView({ block: 'nearest' })
  }, [focus])

  return (
    <div
      ref={listRef}
      className={`list${projects ? ' with-project' : ''}`}
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
          project={projects?.get(projectKeyOf(session)) ?? null}
          needle={needle}
          showAgent={showAgent}
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
  return event.metaKey || event.ctrlKey ? 'toggle' : 'focus'
}

const SessionRow = memo(function SessionRow({
  session,
  project,
  needle,
  showAgent,
  selected,
  focused,
  now,
  onClick,
}: {
  session: SessionSummary
  project: Project | null
  needle: string
  showAgent: boolean
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
        className="check-cell"
        aria-hidden="true"
        onClick={(event) => {
          event.stopPropagation()
          onClick(session.key, event.shiftKey ? 'range' : 'check')
        }}
      >
        <span className="check" />
      </span>
      <span className="row-title">
        {showAgent && <AgentMark agent={session.agent} client={session.client} />}
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
      {project && (
        <span className="row-project truncate" title={session.cwd ?? undefined}>
          {project.name}
          {project.parent && <span className="scope-parent"> {project.parent}</span>}
        </span>
      )}
      {!project && (
        <span className="row-client truncate" title={session.clientDetail || undefined}>
          {CLIENT_LABEL[session.client]}
        </span>
      )}
      <time className="row-time" dateTime={session.lastActivity} title={absoluteTime(session.lastActivity)}>
        {relativeTime(session.lastActivity, now)}
      </time>
    </div>
  )
})
