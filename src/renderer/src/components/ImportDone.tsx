import type { SessionKey } from '../../../shared/sessions'
import { useHomeDir } from '../hooks'
import { AGENT_LABEL, plural, REVEAL_LABEL, sessionTitle, shortCommand, tildePath } from '../model/format'
import { describeOutcome, OUTCOMES } from '../model/importing'
import type { Screen } from '../state'
import { CommandLine, CopyButton } from './common'

type DoneScreen = Extract<Screen, { kind: 'import-done' }>

export function ImportDone({ screen, onDone }: { screen: DoneScreen; onDone: () => void }) {
  const { archive, result } = screen
  const home = useHomeDir()
  const info = new Map(archive.summary.sessions.map((session) => [session.key, session]))
  const placed = result.outcomes.filter((outcome) => outcome.status === 'created' || outcome.status === 'updated')
  const failed = result.outcomes.filter((outcome) => outcome.status === 'failed' || outcome.status === 'refused')
  const agents = [...new Set(placed.map((outcome) => AGENT_LABEL[info.get(outcome.key)?.agent ?? 'claude-code']))]
  const resumes = new Map(
    result.outcomes.flatMap((outcome) => (outcome.status === 'created' || outcome.status === 'updated' ? [[outcome.key, shortCommand(outcome.resumeCommand, home)] as const] : [])),
  )

  return (
    <div className="import">
      <div className="import-scroll">
        <header className="import-head">
          <h1>{placed.length > 0 ? `${plural(placed.length, 'session')} placed` : 'Nothing was imported'}</h1>
          <p className="dim">
            {placed.length > 0 &&
              `The files are where ${agents.join(' and ')} looks for them. Pull your latest changes into each folder, then run a resume command in a terminal. Agent Sessions cannot check that the agent opens them. `}
            {failed.length > 0 && `${plural(failed.length, 'session')} did not import.`}
          </p>
        </header>

        <section className="panel" aria-labelledby="outcomes-heading">
          <header className="panel-head row-between">
            <h2 id="outcomes-heading">Results</h2>
            {resumes.size > 1 && <CopyButton text={[...resumes.values()].join('\n')} label="Copy all commands" />}
          </header>
          <ul className="plan">
            {result.outcomes.map((outcome) => (
              <OutcomeRow key={outcome.key} sessionKey={outcome.key} title={sessionTitle(info.get(outcome.key) ?? { title: null, id: outcome.key })} label={OUTCOMES[outcome.status]} message={describeOutcome(outcome)} resume={resumes.get(outcome.key) || null} />
            ))}
          </ul>
        </section>
      </div>
      <footer className="statusbar">
        {result.backupDir ? (
          <span className="statusbar-note">
            <span className="dim truncate">
              Backups of replaced copies: <code className="selectable">{tildePath(result.backupDir, home)}</code>
            </span>
            <button type="button" className="button ghost small" onClick={() => void window.api.revealBackups()}>
              {REVEAL_LABEL}
            </button>
          </span>
        ) : (
          <span />
        )}
        <span className="statusbar-actions">
          <button type="button" className="button primary" onClick={onDone} autoFocus>
            Back to sessions
          </button>
        </span>
      </footer>
    </div>
  )
}

function OutcomeRow({
  sessionKey,
  title,
  label,
  message,
  resume,
}: {
  sessionKey: SessionKey
  title: string
  label: (typeof OUTCOMES)[keyof typeof OUTCOMES]
  message: string | null
  resume: string | null
}) {
  return (
    <li className="outcome" data-key={sessionKey}>
      <span className="outcome-head">
        <span className={`badge tone-${label.tone}`}>{label.label}</span>
        <span className="plan-title truncate">{title}</span>
      </span>
      {message && <span className="plan-message">{message}</span>}
      {resume && <CommandLine command={resume} />}
    </li>
  )
}
