import type { ReactNode } from 'react'
import type { SessionSummary } from '../../../shared/sessions'
import { absoluteTime, AGENT_LABEL, CLIENT_LABEL, formatBytes, pickerNote, plural, sessionTitle } from '../model/format'
import { CommandLine, CopyButton } from './common'

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function Copyable({ text }: { text: string }) {
  return (
    <span className="copyable">
      <span className="mono selectable">{text}</span>
      <CopyButton text={text} />
    </span>
  )
}

export function SessionDetail({ session }: { session: SessionSummary | null }) {
  if (!session) return <aside className="detail detail-empty" aria-label="Session details" />

  const otherCwds = session.cwds.filter((cwd) => cwd !== session.cwd)
  const notes: string[] = []
  if (session.live) notes.push('Running on this machine now. An export snapshots it up to the last complete line.')
  if (session.hiddenFromPicker) notes.push(pickerNote(session.agent, session.clientDetail))
  if (session.archived) notes.push(`Archived in ${AGENT_LABEL[session.agent]}.`)

  return (
    <aside className="detail" aria-label="Session details">
      <header className="detail-head">
        <h2>{sessionTitle(session)}</h2>
        <p className="dim">
          {AGENT_LABEL[session.agent]} · {CLIENT_LABEL[session.client]}
        </p>
      </header>

      {notes.map((note) => (
        <p key={note} className="note">
          {note}
        </p>
      ))}

      <section>
        <h3>Resume</h3>
        <CommandLine command={session.resumeCommand} />
      </section>

      <dl className="fields">
        <Field label="Session ID">
          <Copyable text={session.id} />
        </Field>
        <Field label="Folder">{session.cwd ? <Copyable text={session.cwd} /> : 'Not recorded'}</Field>
        {otherCwds.length > 0 && (
          <Field label="Also ran in">
            {otherCwds.map((cwd) => (
              <span key={cwd} className="mono selectable block">
                {cwd}
              </span>
            ))}
          </Field>
        )}
        <Field label="Client">{session.clientDetail || CLIENT_LABEL[session.client]}</Field>
        <Field label="CLI version">{session.cliVersion ?? 'Unknown'}</Field>
        <Field label="Started">{absoluteTime(session.createdAt)}</Field>
        <Field label="Last activity">{absoluteTime(session.lastActivity)}</Field>
        <Field label="Files">
          {plural(session.fileCount, 'file')} · {formatBytes(session.sizeBytes)}
        </Field>
      </dl>
    </aside>
  )
}
