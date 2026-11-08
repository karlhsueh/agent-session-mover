import type { SessionKey } from '../../../shared/sessions'
import { AGENT_LABEL, plural, sessionTitle } from '../model/format'
import { describeOutcome, OUTCOMES } from '../model/importing'
import type { Screen } from '../state'
import { CommandLine } from './common'

type DoneScreen = Extract<Screen, { kind: 'import-done' }>

export function ImportDone({ screen, onDone }: { screen: DoneScreen; onDone: () => void }) {
  const { archive, result, resumeCommands } = screen
  const info = new Map(archive.summary.sessions.map((session) => [session.key, session]))
  const placed = result.outcomes.filter((outcome) => outcome.status === 'created' || outcome.status === 'updated')
  const failed = result.outcomes.filter((outcome) => outcome.status === 'failed' || outcome.status === 'refused')
  const agents = [...new Set(placed.map((outcome) => AGENT_LABEL[info.get(outcome.key)?.agent ?? 'claude-code']))]

  return (
    <div className="import">
      <div className="import-scroll">
        <header className="import-head">
          <h1>{placed.length > 0 ? `${plural(placed.length, 'session')} placed` : 'Nothing was imported'}</h1>
          <p className="dim">
            {placed.length > 0 &&
              `The files are where ${agents.join(' and ')} looks for them. Run a resume command in a terminal to continue. Agent Sessions cannot check that the agent opens them. `}
            {failed.length > 0 && `${plural(failed.length, 'session')} did not import.`}
          </p>
        </header>

        <section className="panel" aria-labelledby="outcomes-heading">
          <header className="panel-head">
            <h2 id="outcomes-heading">Results</h2>
          </header>
          <ul className="plan">
            {result.outcomes.map((outcome) => (
              <OutcomeRow key={outcome.key} sessionKey={outcome.key} title={sessionTitle(info.get(outcome.key) ?? { title: null, id: outcome.key })} label={OUTCOMES[outcome.status]} message={describeOutcome(outcome)} resume={outcome.status === 'created' || outcome.status === 'updated' ? (resumeCommands.get(outcome.key) ?? null) : null} />
            ))}
          </ul>
        </section>
      </div>
      <footer className="statusbar">
        <span className="dim selectable">Run {result.runId}</span>
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
    <li className="plan-row outcome" data-key={sessionKey}>
      <div className="plan-main">
        <span className="plan-title">
          <span className="truncate">{title}</span>
        </span>
        {message && <span className="plan-message">{message}</span>}
        {resume && <CommandLine command={resume} />}
      </div>
      <span className={`badge tone-${label.tone}`}>{label.label}</span>
    </li>
  )
}
