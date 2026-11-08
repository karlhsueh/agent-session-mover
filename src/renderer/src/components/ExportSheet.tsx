import type { ProgressEvent, SessionSummary } from '../../../shared/sessions'
import type { Screen } from '../state'
import { formatBytes, plural, REVEAL_LABEL, sessionTitle } from '../model/format'
import { ErrorBanner, ProgressBar, Sheet } from './common'

type ExportScreen = Extract<Screen, { kind: 'export-confirm' | 'exporting' | 'export-done' }>

interface Props {
  screen: ExportScreen
  sessions: readonly SessionSummary[]
  progress: ProgressEvent | null
  onConfirm: () => void
  onClose: () => void
}

export function ExportSheet({ screen, sessions, progress, onConfirm, onClose }: Props) {
  if (screen.kind === 'export-done') {
    const { result } = screen
    return (
      <Sheet label="Archive saved" onClose={onClose}>
        <h2>Archive saved</h2>
        <p className="dim">
          {plural(result.sessionCount, 'session')} · {plural(result.fileCount, 'file')} · {formatBytes(result.bytes)}
        </p>
        <code className="path-block">{result.filePath}</code>
        {result.liveKeys.length > 0 && (
          <p className="note">{plural(result.liveKeys.length, 'session was', 'sessions were')} running. Their snapshot ends at the last complete line.</p>
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
    const fraction = progress?.operation === 'export' && progress.total > 0 ? progress.done / progress.total : null
    return (
      <Sheet label="Exporting">
        <h2>Exporting {plural(screen.keys.length, 'session')}</h2>
        <ProgressBar value={fraction} label="Export progress" />
        <p className="dim">{progress?.operation === 'export' ? `${progress.done} of ${progress.total}` : 'Choose where to save the archive.'}</p>
      </Sheet>
    )
  }

  return (
    <Sheet label={`Export ${plural(chosen.length, 'session')}`} onClose={onClose}>
      <h2>Export {plural(chosen.length, 'session')}</h2>
      {screen.error && <ErrorBanner error={screen.error} />}
      <p>The archive holds each full transcript, unredacted. Anyone with the file can read:</p>
      <ul className="bullets">
        <li>the account email and account ids recorded in the session</li>
        <li>system prompts and every message</li>
        <li>contents of files and output of commands the agent read</li>
      </ul>
      <p className="dim">Credentials, auth tokens, settings, and prompt history are never included.</p>
      {live.length > 0 && (
        <div className="note">
          <p>
            {plural(live.length, 'session is', 'sessions are')} running now. The archive gets a snapshot that ends at the last complete line.
          </p>
          <ul className="bullets live-list">
            {live.map((session) => (
              <li key={session.key}>
                <span className="truncate block">{sessionTitle(session)}</span>
              </li>
            ))}
          </ul>
        </div>
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
