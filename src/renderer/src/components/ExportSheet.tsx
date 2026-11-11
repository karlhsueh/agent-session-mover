import type { ProgressEvent, SessionSummary } from '../../../shared/sessions'
import type { Screen } from '../state'
import { useHomeDir } from '../hooks'
import { formatBytes, MOD, plural, REVEAL_LABEL, sessionTitle, tildePath } from '../model/format'
import { type ProjectLabel, projectLabels, projectsOf } from '../model/scope'
import { ErrorBanner, PathText, ProgressBar, Sheet } from './common'

type ExportScreen = Extract<Screen, { kind: 'export-confirm' | 'exporting' | 'export-done' }>

interface Props {
  screen: ExportScreen
  sessions: readonly SessionSummary[]
  progress: ProgressEvent | null
  onConfirm: () => void
  onClose: () => void
}

export function ExportSheet({ screen, sessions, progress, onConfirm, onClose }: Props) {
  const home = useHomeDir()
  if (screen.kind === 'export-done') {
    const { result } = screen
    return (
      <Sheet label="Archive saved" onClose={onClose}>
        <h2>Archive saved</h2>
        <p className="dim">
          {plural(result.sessionCount, 'session')} · {plural(result.fileCount, 'file')} · {formatBytes(result.bytes)}
        </p>
        <code className="path-block" title={result.filePath}>
          <PathText path={tildePath(result.filePath, home)} />
        </code>
        <p>Next: move this file to the other computer and open it with Import… ({MOD}O).</p>
        {result.liveKeys.length > 0 && (
          <p className="note">
            {result.liveKeys.length === 1
              ? '1 session was running. Its snapshot ends at the last complete line.'
              : `${result.liveKeys.length} sessions were running. Their snapshots end at the last complete line.`}
          </p>
        )}
        <div className="sheet-actions">
          <button type="button" className="button" onClick={() => void window.api.revealExport()}>
            {REVEAL_LABEL}
          </button>
          <button type="button" className="button primary" onClick={onClose} autoFocus>
            Done
          </button>
        </div>
      </Sheet>
    )
  }

  const chosen = sessions.filter((session) => screen.keys.includes(session.key))
  const live = chosen.filter((session) => session.live)

  if (screen.kind === 'exporting') {
    const step = progress?.operation === 'export' ? progress : null
    // Reading is a small share of an export, so the bar only measures the write.
    const fraction = step?.phase === 'write' && step.bytesTotal > 0 ? step.bytesDone / step.bytesTotal : null
    const status = !step
      ? 'Choose where to save the archive.'
      : step.phase === 'read'
        ? `Reading ${step.current} of ${plural(step.total, 'session')}`
        : `Writing ${formatBytes(step.bytesDone)} of ${formatBytes(step.bytesTotal)}`
    return (
      <Sheet label="Exporting">
        <h2>Exporting {plural(screen.keys.length, 'session')}</h2>
        <ProgressBar value={fraction} label="Export progress" />
        <p className="dim">{status}</p>
      </Sheet>
    )
  }

  return (
    <Sheet label={`Export ${plural(chosen.length, 'session')}`} onClose={onClose}>
      <h2>Export {plural(chosen.length, 'session')}</h2>
      {screen.error && <ErrorBanner error={screen.error} />}
      <Contents sessions={chosen} labels={projectLabels(sessions)} />
      <p>The archive holds each full transcript, unredacted. Anyone with the file can read:</p>
      <ul className="bullets">
        <li>the account email and account ids recorded in the session</li>
        <li>system prompts and every message</li>
        <li>contents of files and output of commands the agent read</li>
        <li>this computer's name and each project's git remote address</li>
      </ul>
      <p className="dim">The archive never includes credentials, auth tokens, settings, prompt history, or your project files. Push or copy the project so the other computer has your latest changes.</p>
      {live.length > 0 && (
        <p className="note">
          {live.length === 1 ? 'The session marked Live is' : `The ${live.length} sessions marked Live are`} running now. The archive gets a snapshot that ends at the last
          complete line.
        </p>
      )}
      <div className="sheet-actions">
        <button type="button" className="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="button primary" onClick={onConfirm} autoFocus>
          Choose location…
        </button>
      </div>
    </Sheet>
  )
}

/** What leaves this computer, by project, so the user can check the pick before saving. */
function Contents({ sessions, labels }: { sessions: readonly SessionSummary[]; labels: ReadonlyMap<string | null, ProjectLabel> }) {
  const projects = projectsOf(sessions)
  const byKey = new Map(sessions.map((session) => [session.key, session]))
  const subagents = sessions.reduce((sum, session) => sum + session.subagents.length, 0)
  return (
    <section className="export-contents" aria-label="Sessions in the archive">
      <p className="dim">
        From {plural(projects.length, 'project')}
        {subagents > 0 && `, with ${plural(subagents, 'subagent')}`}.
      </p>
      <div className="export-list">
        {projects.map((project) => (
          <div key={project.key} className="export-project">
            <div className="export-project-name truncate" title={project.path ?? undefined}>
              {project.name}
              {labels.get(project.path)?.parent && <span className="scope-parent"> {labels.get(project.path)?.parent}</span>}
            </div>
            <ul>
              {project.sessions.map((key) => {
                const session = byKey.get(key)!
                return (
                  <li key={key}>
                    <span className="truncate">{sessionTitle(session)}</span>
                    {session.live && <span className="badge live">Live</span>}
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}
