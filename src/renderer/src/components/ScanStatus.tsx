import { AGENT_IDS, type ScanProgress } from '../../../shared/sessions'
import { AGENT_LABEL, formatBytes, plural } from '../model/format'
import type { Listings, PendingScan } from '../model/listing'
import { AgentMark, ProgressBar } from './common'

function fraction(progress: ScanProgress | null): number | null {
  if (!progress) return null
  return progress.bytesTotal > 0 ? progress.bytesDone / progress.bytesTotal : progress.filesTotal > 0 ? progress.filesDone / progress.filesTotal : null
}

/** `31 of 186 files · 210 MB of 640 MB`, or null before the first count. */
function counts(progress: ScanProgress | null): string | null {
  if (!progress) return null
  return `${progress.filesDone} of ${plural(progress.filesTotal, 'file')} · ${formatBytes(progress.bytesDone)} of ${formatBytes(progress.bytesTotal)}`
}

/** One slim line per agent still reading, for the status bar once some sessions are on screen. */
export function ScanLine({ scans }: { scans: PendingScan[] }) {
  if (scans.length === 0) return null
  return (
    // Counts change ten times a second, so the status bar's live region must not read each one aloud.
    <span className="scan-line" aria-live="off">
      {scans.map(({ agent, progress }) => (
        <span key={agent} className="scan-item">
          <ProgressBar value={fraction(progress)} label={`Reading ${AGENT_LABEL[agent]} sessions`} />
          <span>
            Reading {AGENT_LABEL[agent]}
            {progress ? <span className="dim"> · {counts(progress)}</span> : '…'}
          </span>
        </span>
      ))}
    </span>
  )
}

/** The first launch before any session can show: every agent's state, each with its own bar. */
export function ScanPanel({ listings, scans }: { listings: Listings; scans: PendingScan[] }) {
  return (
    <div className="empty">
      <div className="scan-panel" role="region" aria-label="Reading session stores" aria-busy="true">
        <h1>Reading session stores</h1>
        <ul>
          {AGENT_IDS.map((agent) => {
            const answer = listings[agent]
            const scan = scans.find((each) => each.agent === agent)
            return (
              <li key={agent}>
                <span className="scan-agent">
                  <AgentMark agent={agent} />
                  {AGENT_LABEL[agent]}
                </span>
                <span className="dim scan-detail">
                  {answer ? (answer.problems.length > 0 ? 'Could not read the store' : plural(answer.sessions.length, 'session')) : (counts(scan?.progress ?? null) ?? 'Looking for sessions…')}
                </span>
                <ProgressBar value={answer ? 1 : fraction(scan?.progress ?? null)} label={`Reading ${AGENT_LABEL[agent]} sessions`} />
              </li>
            )
          })}
        </ul>
        <p className="dim">The first read takes longest. Later launches read only sessions that changed.</p>
      </div>
    </div>
  )
}
