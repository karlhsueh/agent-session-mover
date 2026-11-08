import { useEffect, type ReactNode } from 'react'
import type { SessionSummary } from '../../../shared/sessions'
import { absoluteTime, AGENT_LABEL, CLIENT_LABEL, formatBytes, pickerNote, plural, relativeTime, sessionTitle, shortCommand, tildePath } from '../model/format'
import type { DisplayRow } from '../model/rows'
import { AgentMark, CommandText, CopyButton, PathText } from './common'

export type DetailTarget =
  | { kind: 'session'; session: SessionSummary; subagent: string | null }
  | { kind: 'group'; row: Extract<DisplayRow, { kind: 'group' }>; sessions: SessionSummary[] }
  | null

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

export function SessionDetail({ target, home, now }: { target: DetailTarget; home: string; now: number }) {
  if (!target) return <aside className="detail detail-empty" aria-label="Session details" />
  if (target.kind === 'group') return <GroupDetail row={target.row} sessions={target.sessions} home={home} now={now} />
  const { session } = target

  const otherCwds = session.cwds.filter((cwd) => cwd !== session.cwd)
  const notes: string[] = []
  if (session.live) notes.push('Running on this machine now. An export snapshots it up to the last complete line.')
  if (session.hiddenFromPicker) notes.push(pickerNote(session.agent, session.clientDetail))
  if (session.archived) notes.push(`Archived in ${AGENT_LABEL[session.agent]}.`)
  const command = shortCommand(session.resumeCommand, home)

  return (
    <aside className="detail" aria-label="Session details">
      <header className="detail-head">
        <h2>{sessionTitle(session)}</h2>
        <p className="detail-agent">
          <AgentMark agent={session.agent} />
          {AGENT_LABEL[session.agent]} · <span title={session.clientDetail || undefined}>{CLIENT_LABEL[session.client]}</span>
        </p>
      </header>

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
        {otherCwds.length > 0 && (
          <Field label="Also ran in">
            {otherCwds.map((cwd) => (
              <span key={cwd} className="mono selectable block" title={cwd}>
                <PathText path={tildePath(cwd, home)} />
              </span>
            ))}
          </Field>
        )}
        <Field label="Version">{session.cliVersion ?? 'Unknown'}</Field>
        <Field label="Started">{absoluteTime(session.createdAt)}</Field>
        <Field label="Last active">{absoluteTime(session.lastActivity)}</Field>
        <Field label="Size">
          {plural(session.fileCount, 'file')} · {formatBytes(session.sizeBytes)}
        </Field>
      </dl>

      {session.subagents.length > 0 && <Subagents session={session} current={target.subagent} now={now} />}
    </aside>
  )
}

function subagentItemId(id: string): string {
  return `subagent-${encodeURIComponent(id)}`
}

function Subagents({ session, current, now }: { session: SessionSummary; current: string | null; now: number }) {
  useEffect(() => {
    if (current) document.getElementById(subagentItemId(current))?.scrollIntoView({ block: 'nearest' })
  }, [current])
  return (
    <section aria-label="Subagents">
      <h3>
        Subagents <span className="count">{session.subagents.length}</span>
      </h3>
      <p className="dim small">Exported and imported with this session.</p>
      <ul className="subagents">
        {session.subagents.map((subagent) => (
          <li key={subagent.id} id={subagentItemId(subagent.id)} className={subagent.id === current ? 'current' : undefined}>
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

function GroupDetail({ row, sessions, home, now }: { row: Extract<DisplayRow, { kind: 'group' }>; sessions: SessionSummary[]; home: string; now: number }) {
  const subagents = sessions.reduce((sum, session) => sum + session.subagents.length, 0)
  const bytes = sessions.reduce((sum, session) => sum + session.sizeBytes, 0)
  return (
    <aside className="detail" aria-label="Session details">
      <header className="detail-head">
        <h2>{row.folder}</h2>
        <p className="dim">Project folder</p>
      </header>
      <dl className="fields">
        <Field label="Folder">{row.path ? <Copyable path shown={tildePath(row.path, home)} copy={row.path} /> : 'Not recorded'}</Field>
        <Field label="Sessions">
          {sessions.length}
          {subagents > 0 && <span className="dim"> · {plural(subagents, 'subagent')}</span>}
        </Field>
        <Field label="Size">{formatBytes(bytes)}</Field>
        <Field label="Last active">
          {absoluteTime(row.newest)} <span className="dim">({relativeTime(row.newest, now)})</span>
        </Field>
      </dl>
      <p className="dim small">Space selects every session in this folder. Left and Right fold it.</p>
    </aside>
  )
}
