import { useEffect, type ReactNode } from 'react'
import type { SessionKey, SessionPreview, SessionSummary } from '../../../shared/sessions'
import { absoluteTime, AGENT_LABEL, CLIENT_LABEL, formatBytes, pickerNote, plural, relativeTime, sessionTitle, shortCommand, tildePath } from '../model/format'
import type { Loadable } from '../state'
import { AgentMark, CommandText, CopyButton, PathText } from './common'
import { Conversation } from './Conversation'

export type DetailTab = 'overview' | 'conversation'
const TABS: { tab: DetailTab; label: string }[] = [
  { tab: 'overview', label: 'Overview' },
  { tab: 'conversation', label: 'Conversation' },
]

export function parseDetailTab(raw: string | null): DetailTab {
  return raw === 'conversation' ? 'conversation' : 'overview'
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  )
}

/** An id stays on one line, cut with an ellipsis; a path wraps at its separators. Copy carries the whole value. */
function Copyable({ shown, copy, path = false }: { shown: string; copy: string; path?: boolean }) {
  return (
    <span className="copyable">
      <span className={path ? 'mono selectable' : 'mono truncate selectable'} title={copy}>
        {path ? <PathText path={shown} /> : shown}
      </span>
      <CopyButton text={copy} />
    </span>
  )
}

interface Props {
  session: SessionSummary | null
  home: string
  now: number
  tab: DetailTab
  onTab: (tab: DetailTab) => void
  preview: (key: SessionKey) => Loadable<SessionPreview> | null
  onPreview: (key: SessionKey) => void
}

export function SessionDetail({ session, home, now, tab, onTab, preview, onPreview }: Props) {
  const key = session?.key ?? null
  useEffect(() => {
    if (key && tab === 'conversation') onPreview(key)
  }, [key, tab, onPreview])

  if (!session) return <aside className="detail detail-empty" aria-label="Session details" />

  return (
    <aside className="detail" aria-label="Session details">
      <header className="detail-head">
        <h2>{sessionTitle(session)}</h2>
        <p className="detail-agent">
          <AgentMark agent={session.agent} />
          {AGENT_LABEL[session.agent]} · <span title={session.clientDetail || undefined}>{CLIENT_LABEL[session.client]}</span>
        </p>
      </header>
      <Tabs tab={tab} onTab={onTab} />
      <div className="detail-panel" role="tabpanel" id="detail-panel" aria-labelledby={`detail-tab-${tab}`}>
        {tab === 'overview' ? <Overview session={session} home={home} now={now} /> : <Conversation state={preview(session.key)} onRetry={() => onPreview(session.key)} />}
      </div>
    </aside>
  )
}

/** A click keeps focus in the list, so arrow keys go on moving through sessions with either tab open. */
function Tabs({ tab, onTab }: { tab: DetailTab; onTab: (tab: DetailTab) => void }) {
  return (
    <div className="tabs" role="tablist" aria-label="Detail view">
      {TABS.map((each) => (
        <button
          key={each.tab}
          type="button"
          role="tab"
          id={`detail-tab-${each.tab}`}
          aria-selected={tab === each.tab}
          aria-controls="detail-panel"
          className={tab === each.tab ? 'tab active' : 'tab'}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onTab(each.tab)}
        >
          {each.label}
        </button>
      ))}
    </div>
  )
}

function Overview({ session, home, now }: { session: SessionSummary; home: string; now: number }) {
  const otherCwds = session.cwds.filter((cwd) => cwd !== session.cwd)
  const notes: string[] = []
  if (session.live) notes.push('Running on this machine now. An export snapshots it up to the last complete line.')
  if (session.hiddenFromPicker) notes.push(pickerNote(session.agent, session.clientDetail))
  if (session.archived) notes.push(`Archived in ${AGENT_LABEL[session.agent]}.`)
  const command = shortCommand(session.resumeCommand, home)

  return (
    <>
      {notes.map((note) => (
        <p key={note} className="note">
          {note}
        </p>
      ))}

      <section>
        <div className="section-head">
          <h3>Resume</h3>
          <CopyButton text={command} />
        </div>
        <pre className="command-block">
          <CommandText command={command} />
        </pre>
      </section>

      <dl className="fields">
        <Field label="Session ID">
          <Copyable shown={session.id} copy={session.id} />
        </Field>
        <Field label="Folder">{session.cwd ? <Copyable path shown={tildePath(session.cwd, home)} copy={session.cwd} /> : 'Not recorded'}</Field>
        {(otherCwds.length > 0 || !session.cwdsComplete) && (
          <Field label="Also ran in">
            {otherCwds.map((cwd) => (
              <span key={cwd} className="mono selectable block" title={cwd}>
                <PathText path={tildePath(cwd, home)} />
              </span>
            ))}
            {!session.cwdsComplete && <span className="dim block">{otherCwds.length > 0 ? 'Maybe more.' : 'Not known.'} The list reads only the start and end of a transcript this long. An export reads all of it.</span>}
          </Field>
        )}
        <Field label="Version">{session.cliVersion ?? 'Unknown'}</Field>
        <Field label="Started">{absoluteTime(session.createdAt)}</Field>
        <Field label="Last active">{absoluteTime(session.lastActivity)}</Field>
        <Field label="Size">
          {plural(session.fileCount, 'file')} · {formatBytes(session.sizeBytes)}
        </Field>
      </dl>

      {session.subagents.length > 0 && <Subagents session={session} now={now} />}
    </>
  )
}

function Subagents({ session, now }: { session: SessionSummary; now: number }) {
  return (
    <section aria-label="Subagents">
      <h3>
        Subagents <span className="count">{session.subagents.length}</span>
      </h3>
      <p className="dim small">Exported and imported with this session.</p>
      <ul className="subagents">
        {session.subagents.map((subagent) => (
          <li key={subagent.id}>
            <span className="sub-role truncate">{subagent.role ?? 'Agent'}</span>
            <span className="sub-title">{subagent.title ?? `Agent ${subagent.id}`}</span>
            {subagent.lastActivity && (
              <time className="row-time" dateTime={subagent.lastActivity} title={absoluteTime(subagent.lastActivity)}>
                {relativeTime(subagent.lastActivity, now)}
              </time>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
