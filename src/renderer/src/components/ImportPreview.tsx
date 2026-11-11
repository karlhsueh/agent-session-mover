import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ConflictChoice, ImportRequest, PathMapping, ProgressEvent, SessionKey } from '../../../shared/sessions'
import { useHomeDir, usePreviews } from '../hooks'
import { IS_MAC, MOD, platformLabel, plural, shortDateTime } from '../model/format'
import { conflictChoice, conflictKeys, isActionable, planRank, runSummary, selectedForImport, verdict } from '../model/importing'
import { projectLabels } from '../model/scope'
import { shownPreview, type PreviewScreen } from '../state'
import { ErrorBanner, Kbd, ProgressBar, Sheet } from './common'
import { Fold } from './ImportParts'
import { MappingEditor } from './MappingEditor'
import { ConflictBar, PlanRow } from './PlanRow'

interface Props {
  screen: PreviewScreen
  /** True while the import runs. The screen stays visible under the progress sheet but takes no keys. */
  running: boolean
  /** Byte progress while this computer is checked against the archive. */
  progress: ProgressEvent | null
  onMappingChange: (source: string, target: string) => void
  onToggle: (key: SessionKey) => void
  onChoose: (keys: readonly SessionKey[], choice: ConflictChoice) => void
  onRun: (requests: ImportRequest[]) => void
  onBack: () => void
  onDismissError: () => void
}

const RUN_KEY = `${MOD}${IS_MAC ? '↩' : 'Enter'}`

/** Fields where Esc and Enter already mean something. A checkbox is not one. */
function inTextField(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement) return !['checkbox', 'radio', 'button'].includes(target.type)
  return target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)
}

export function ImportPreview({ screen, running, progress, onMappingChange, onToggle, onChoose, onRun, onBack, onDismissError }: Props) {
  const { archive, preview: state, excluded, conflicts } = screen
  const preview = shownPreview(state)
  // Until the first answer, the panels would show a layout the answer then rearranges, so they wait for it.
  const firstCheck = state.status === 'loading' && preview === null
  const byKey = new Map((preview?.sessions ?? []).map((session) => [session.key, session]))
  const rank = (key: SessionKey) => planRank(byKey.get(key)?.action ?? null)
  const sessions = [...archive.summary.sessions].sort((a, b) => rank(a.key) - rank(b.key) || b.lastActivity.localeCompare(a.lastActivity))
  const identical = sessions.filter((session) => byKey.get(session.key)?.action.kind === 'skip-identical')
  const listed = sessions.filter((session) => byKey.get(session.key)?.action.kind !== 'skip-identical')
  const requests = selectedForImport(preview, excluded, conflicts)
  const conflicted = conflictKeys(preview)
  const parts = preview && state.status === 'ready' ? verdict(preview, excluded, conflicts) : []
  const token = archive.token
  const home = useHomeDir()
  const listedFolders = new Set(screen.mappings.map((mapping) => mapping.target.replace(/[\\/]+$/, '')))
  const [archived, requestArchived] = usePreviews(useCallback((key: SessionKey) => window.api.previewArchiveSession(token, key), [token]), token)
  // The copy already on this computer, for a conflict. Its key is the same session's.
  const [stored, requestStored] = usePreviews(useCallback((key: SessionKey) => window.api.previewSession(key), []), token)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const canRun = requests.length > 0 && state.status === 'ready'
  const run = runSummary(preview, requests)
  const labels = projectLabels(archive.summary.sessions)
  // The suggestions main made when the archive opened, so leaving can tell what the user changed.
  const [suggested] = useState(screen.mappings)
  const changes = unsavedChanges(suggested, screen.mappings, conflicts)
  const [confirming, setConfirming] = useState(false)
  const leave = () => (changes.phrases.length > 0 ? setConfirming(true) : onBack())

  // A choice can add a folder to the Folders panel above, so the row the user clicked is held where it was.
  const scroller = useRef<HTMLDivElement>(null)
  const anchor = useRef<{ selector: string; top: number } | null>(null)
  const keepInPlace = (selector: string, change: () => void) => {
    const element = scroller.current?.querySelector(selector)
    anchor.current = element ? { selector, top: element.getBoundingClientRect().top } : null
    change()
  }
  useLayoutEffect(() => {
    const held = anchor.current
    anchor.current = null
    const element = held && scroller.current?.querySelector(held.selector)
    if (held && element && scroller.current) scroller.current.scrollTop += element.getBoundingClientRect().top - held.top
  })

  useEffect(() => {
    if (running || confirming) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || inTextField(event.target)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        leave()
      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canRun) {
        event.preventDefault()
        onRun(requests)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const request = (side: CopySide, key: SessionKey) => (side === 'archive' ? requestArchived(key) : requestStored(key))
  const toggleOpen = (side: CopySide, key: SessionKey) => {
    const next = new Set(open)
    if (!next.delete(`${side}\n${key}`)) {
      next.add(`${side}\n${key}`)
      request(side, key)
    }
    setOpen(next)
  }

  const row = (session: (typeof sessions)[number], checks: boolean) => (
    <PlanRow
      key={session.key}
      session={session}
      folderLabel={labels.get(session.cwd)}
      plan={byKey.get(session.key) ?? null}
      checks={checks}
      included={!excluded.has(session.key)}
      onToggle={onToggle}
      choice={conflictChoice(conflicts, session.key)}
      decided={conflicts.has(session.key)}
      onChoose={(choice) => keepInPlace(`.plan-row[data-key="${session.key}"]`, () => onChoose([session.key], choice))}
      conversation={open.has(`archive\n${session.key}`) ? archived(session.key) : undefined}
      here={open.has(`here\n${session.key}`) ? stored(session.key) : undefined}
      onConversation={(side) => toggleOpen(side, session.key)}
      onRetry={(side) => request(side, session.key)}
      home={home}
      listedFolders={listedFolders}
    />
  )
  // A column for checkboxes only when some row has one, kept across both lists so their badges line up.
  const checks = (preview?.sessions ?? []).some((session) => isActionable(session.action))
  const rows = (list: typeof sessions) => list.map((session) => row(session, checks))

  return (
    <div className="import">
      <div className="import-scroll" ref={scroller}>
        <header className="import-head">
          <h1>
            {plural(archive.summary.sessions.length, 'session')} from {archive.summary.source.computerName ?? platformLabel(archive.summary.source.platform)}
          </h1>
          <p className="dim" title={`Home folder on that computer: ${archive.summary.source.homeDir}`}>
            <span className="selectable">{archive.summary.fileName}</span> · exported {shortDateTime(archive.summary.createdAt)}
          </p>
        </header>

        <p className="verdict" role="status">
          {state.status === 'loading' ? (
            <span className="checking">
              <span className="dim">Checking this computer…</span>
              <ProgressBar value={progress?.operation === 'preview' && progress.bytesTotal > 0 ? progress.bytesDone / progress.bytesTotal : null} label="Check progress" />
            </span>
          ) : (
            parts.map((part, index) => (
              <span key={part.kind} className={`verdict-part verdict-${part.kind}`}>
                {index > 0 && <span className="verdict-sep" aria-hidden="true">·</span>}
                {part.text}
              </span>
            ))
          )}
        </p>

        {screen.error && <ErrorBanner error={screen.error} onDismiss={onDismissError} />}
        {state.status === 'failed' && <ErrorBanner error={state.error} />}

        {!firstCheck && (
          <>
            <MappingEditor
              token={token}
              mappings={screen.mappings}
              sessions={archive.summary.sessions}
              preview={preview}
              choices={conflicts}
              checking={state.status === 'loading'}
              sourceHome={archive.summary.source.homeDir}
              sourceSep={archive.summary.source.sep}
              repos={archive.summary.source.repos}
              onChange={onMappingChange}
            />

            <section className="panel" aria-labelledby="sessions-heading" aria-busy={state.status === 'loading'}>
              <header className="panel-head">
                <h2 id="sessions-heading">Sessions</h2>
              </header>
              {conflicted.length > 1 && (
                <ConflictBar keys={conflicted} choices={conflicts} onChoose={(keys, choice) => keepInPlace('.plan-bulk', () => onChoose(keys, choice))} />
              )}
              <ul className={state.status === 'loading' ? 'plan stale' : 'plan'}>{rows(listed)}</ul>
              {identical.length > 0 && (
                <div className="plan-fold">
                  <Fold id="plan-identical" summary={`${plural(identical.length, 'session')} already on this computer`}>
                    <ul className={state.status === 'loading' ? 'plan stale' : 'plan'}>{rows(identical)}</ul>
                  </Fold>
                </div>
              )}
            </section>
          </>
        )}
      </div>

      <footer className="statusbar">
        <span className="dim">
          Agent Session Mover writes files only after you start the import.{run.backups && ` ${run.backups}`}
        </span>
        <span className="statusbar-actions">
          <button type="button" className="button" onClick={leave}>
            Cancel
            <Kbd>Esc</Kbd>
          </button>
          <button type="button" className="button primary" disabled={!canRun} onClick={() => onRun(requests)}>
            {run.label}
            {requests.length > 0 && <Kbd>{RUN_KEY}</Kbd>}
          </button>
        </span>
      </footer>
      {confirming && <LeaveSheet changes={changes} onStay={() => setConfirming(false)} onLeave={onBack} />}
    </div>
  )
}

type CopySide = 'archive' | 'here'

interface Changes {
  /** What leaving would throw away, one phrase per kind of change. */
  phrases: string[]
  /** How the screen starts if the user opens the archive again. */
  restart: string
}

function unsavedChanges(suggested: readonly PathMapping[], mappings: readonly PathMapping[], choices: ReadonlyMap<SessionKey, ConflictChoice>): Changes {
  const before = new Map(suggested.map((mapping) => [mapping.source, mapping.target]))
  const moved = mappings.filter((mapping) => before.get(mapping.source) !== mapping.target).length
  const replacing = [...choices.values()].filter((choice) => choice === 'replace').length
  const restart = [...(moved > 0 ? ['starts from the suggested folders'] : []), ...(replacing > 0 ? ["keeps this computer's copy of every session that differs"] : [])]
  return {
    phrases: [
      ...(moved > 0 ? [moved === 1 ? 'the folder you changed' : `the ${moved} folders you changed`] : []),
      ...(replacing > 0 ? [`your choice to replace ${plural(replacing, 'session')}`] : []),
    ],
    restart: `If you open the archive again, it ${restart.join(' and ')}.`,
  }
}

function LeaveSheet({ changes, onStay, onLeave }: { changes: Changes; onStay: () => void; onLeave: () => void }) {
  return (
    <Sheet label="Leave the import" onClose={onStay}>
      <h2>Leave the import?</h2>
      <p>
        Leaving drops {changes.phrases.join(' and ')}. Nothing has been written yet. {changes.restart}
      </p>
      <div className="sheet-actions">
        <button type="button" className="button" onClick={onLeave}>
          Leave
        </button>
        <button type="button" className="button primary" onClick={onStay} autoFocus>
          Stay
        </button>
      </div>
    </Sheet>
  )
}

export function ImportingSheet({ count, progress, titles }: { count: number; progress: ProgressEvent | null; titles: ReadonlyMap<SessionKey, string> }) {
  const running = progress?.operation === 'import' ? progress : null
  return (
    <Sheet label="Importing">
      <h2>Importing {plural(count, 'session')}</h2>
      <ProgressBar value={running ? importFraction(running) : null} label="Import progress" />
      <p className="dim truncate">{running?.current ? titles.get(running.current) : running ? `${running.done} of ${running.total}` : 'Planning again…'}</p>
    </Sheet>
  )
}

function importFraction(event: Extract<ProgressEvent, { operation: 'import' }>): number | null {
  if (event.bytesTotal > 0) return event.bytesDone / event.bytesTotal
  return event.total > 0 ? event.done / event.total : null
}

export function OpeningSheet({ progress }: { progress: ProgressEvent | null }) {
  if (progress?.operation !== 'open') return null
  return (
    <Sheet label="Verifying archive">
      <h2>Verifying archive</h2>
      <ProgressBar value={progress.bytesTotal > 0 ? progress.bytesRead / progress.bytesTotal : null} label="Verify progress" />
      <p className="dim">The app checks every file against its hash before it shows anything.</p>
    </Sheet>
  )
}
