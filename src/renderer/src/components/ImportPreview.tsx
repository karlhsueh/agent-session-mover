import { useCallback, useEffect, useState } from 'react'
import type { ConflictChoice, ImportRequest, ProgressEvent, SessionImportPreview, SessionInfo, SessionKey, SessionPreview } from '../../../shared/sessions'
import { useHomeDir, usePreviews } from '../hooks'
import { AGENT_LABEL, folderName, IS_MAC, MOD, platformLabel, plural, sessionTitle, shortDateTime } from '../model/format'
import { ACTIONS, conflictChoice, conflictKeys, describeAction, isActionable, planBadge, selectedForImport, warningText, willImport } from '../model/importing'
import { type Loadable, shownPreview, type PreviewScreen } from '../state'
import { ErrorBanner, Kbd, ProgressBar, Sheet } from './common'
import { Conversation } from './Conversation'
import { MappingEditor } from './MappingEditor'

interface Props {
  screen: PreviewScreen
  /** True while the import runs. The screen stays visible under the progress sheet but takes no keys. */
  running: boolean
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

export function ImportPreview({ screen, running, onMappingChange, onToggle, onChoose, onRun, onBack, onDismissError }: Props) {
  const { archive, preview: state, excluded, conflicts } = screen
  const preview = shownPreview(state)
  const byKey = new Map((preview?.sessions ?? []).map((session) => [session.key, session]))
  const sessions = [...archive.summary.sessions].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
  const requests = selectedForImport(preview, excluded, conflicts)
  const conflicted = conflictKeys(preview)
  const counts = new Map<string, number>()
  for (const session of preview?.sessions ?? []) counts.set(session.action.kind, (counts.get(session.action.kind) ?? 0) + 1)
  const token = archive.token
  const home = useHomeDir()
  const listedFolders = new Set(screen.mappings.map((mapping) => mapping.target.replace(/[\\/]+$/, '')))
  const [conversation, requestConversation] = usePreviews(useCallback((key: SessionKey) => window.api.previewArchiveSession(token, key), [token]), token)
  const [open, setOpen] = useState<ReadonlySet<SessionKey>>(new Set())
  const canRun = requests.length > 0 && state.status === 'ready'

  useEffect(() => {
    if (running) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || inTextField(event.target)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        onBack()
      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canRun) {
        event.preventDefault()
        onRun(requests)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const toggleOpen = (key: SessionKey) => {
    const next = new Set(open)
    if (!next.delete(key)) {
      next.add(key)
      requestConversation(key)
    }
    setOpen(next)
  }

  return (
    <div className="import">
      <div className="import-scroll">
        <header className="import-head">
          <button type="button" className="button ghost small" onClick={onBack}>
            ← Sessions
          </button>
          <h1>
            {plural(archive.summary.sessions.length, 'session')} from {platformLabel(archive.summary.source.platform)}
          </h1>
          <p className="dim" title={`Home folder on that computer: ${archive.summary.source.homeDir}`}>
            <span className="selectable">{archive.summary.fileName}</span> · exported {shortDateTime(archive.summary.createdAt)}
          </p>
        </header>

        {screen.error && <ErrorBanner error={screen.error} onDismiss={onDismissError} />}
        {state.status === 'failed' && <ErrorBanner error={state.error} />}

        <MappingEditor
          token={token}
          mappings={screen.mappings}
          sessions={archive.summary.sessions}
          preview={preview}
          checking={state.status === 'loading'}
          sourceHome={archive.summary.source.homeDir}
          sourceSep={archive.summary.source.sep}
          onChange={onMappingChange}
        />

        <section className="panel" aria-labelledby="sessions-heading" aria-busy={state.status === 'loading'}>
          <header className="panel-head row-between">
            <h2 id="sessions-heading">Sessions</h2>
            <p className="dim summary-counts">
              {state.status === 'loading'
                ? 'Checking this computer…'
                : (Object.keys(ACTIONS) as (keyof typeof ACTIONS)[])
                    .filter((kind) => counts.has(kind))
                    .map((kind) => ACTIONS[kind].count(counts.get(kind)!))
                    .join(' · ')}
            </p>
          </header>
          {conflicted.length > 1 && <ConflictBar keys={conflicted} choices={conflicts} onChoose={onChoose} />}
          <ul className={state.status === 'loading' ? 'plan stale' : 'plan'}>
            {sessions.map((session) => (
              <PlanRow
                key={session.key}
                session={session}
                plan={byKey.get(session.key) ?? null}
                included={!excluded.has(session.key)}
                onToggle={onToggle}
                choice={conflictChoice(conflicts, session.key)}
                onChoose={(choice) => onChoose([session.key], choice)}
                conversation={open.has(session.key) ? conversation(session.key) : undefined}
                onConversation={() => toggleOpen(session.key)}
                onRetry={() => requestConversation(session.key)}
                home={home}
                listedFolders={listedFolders}
              />
            ))}
          </ul>
        </section>
      </div>

      <footer className="statusbar">
        <span className="dim">Agent Session Mover writes files only after you start the import. Update and Replace keep a backup of the copy they replace.</span>
        <span className="statusbar-actions">
          <button type="button" className="button" onClick={onBack}>
            Cancel
            <Kbd>Esc</Kbd>
          </button>
          <button type="button" className="button primary" disabled={!canRun} onClick={() => onRun(requests)}>
            {requests.length > 0 ? `Import ${plural(requests.length, 'session')}` : 'Nothing to import'}
            {requests.length > 0 && <Kbd>{RUN_KEY}</Kbd>}
          </button>
        </span>
      </footer>
    </div>
  )
}

interface PlanRowProps {
  session: SessionInfo
  plan: SessionImportPreview | null
  included: boolean
  onToggle: (key: SessionKey) => void
  choice: ConflictChoice
  onChoose: (choice: ConflictChoice) => void
  /** Undefined while the conversation is folded away. */
  conversation: Loadable<SessionPreview> | null | undefined
  onConversation: () => void
  onRetry: () => void
  home: string
  /** Mapping targets, which the Folders section already flags when missing. */
  listedFolders: ReadonlySet<string>
}

function PlanRow({ session, plan, included, onToggle, choice, onChoose, conversation, onConversation, onRetry, home, listedFolders }: PlanRowProps) {
  const actionable = plan !== null && isActionable(plan.action)
  const conflict = plan?.action.kind === 'conflict'
  const id = `plan-${session.key}`
  const shown = conversation !== undefined
  const live = plan !== null && willImport(plan.action, included, choice)
  // Warnings are about resuming, so a row that imports nothing whatever the tick says has none.
  const warnings = actionable || (conflict && choice === 'replace') ? (plan?.warnings ?? []) : []
  const badge = plan && planBadge(plan.action, choice)
  // A conflict row holds buttons, which a label must not wrap.
  const Main = conflict ? 'div' : 'label'
  return (
    <li className={`${live ? 'plan-row' : 'plan-row inert'}${shown ? ' expanded' : ''}`}>
      {conflict ? (
        <span aria-hidden="true" />
      ) : (
        <input id={id} type="checkbox" checked={actionable && included} disabled={!actionable} onChange={() => onToggle(session.key)} />
      )}
      <span className="plan-badge">{badge && <span className={`badge tone-${badge.tone}`}>{badge.label}</span>}</span>
      <Main htmlFor={conflict ? undefined : id} className="plan-main">
        <span className="plan-title">
          <span className="truncate">{sessionTitle(session)}</span>
        </span>
        <span className="plan-meta dim">
          {AGENT_LABEL[session.agent]} · <span title={session.cwd ?? undefined}>{folderName(session.cwd)}</span>
          {plan?.targetCwd && folderName(plan.targetCwd) !== folderName(session.cwd) && (
            <>
              {' → '}
              <span className="plan-target" title={plan.targetCwd}>
                {folderName(plan.targetCwd)}
              </span>
            </>
          )}
        </span>
        {plan && plan.action.kind !== 'create' && <span className="plan-message">{describeAction(plan.action, session)}</span>}
        {warnings.map((warning) => (
          <span key={warning.code} className="plan-warning">
            {warningText(warning, session.agent, home, warning.code === 'target-cwd-missing' && listedFolders.has(warning.path))}
          </span>
        ))}
        {conflict && <ConflictChoices title={sessionTitle(session)} choice={choice} onChoose={onChoose} />}
      </Main>
      <span className="plan-side">
        <button
          type="button"
          className="button ghost small"
          aria-label={`${shown ? 'Hide' : 'Preview'} the conversation of ${sessionTitle(session)}`}
          aria-expanded={shown}
          aria-controls={`${id}-conversation`}
          onClick={onConversation}
        >
          {shown ? 'Hide' : 'Preview'}
        </button>
      </span>
      {shown && (
        <div className="plan-conversation" id={`${id}-conversation`}>
          <Conversation state={conversation} onRetry={onRetry} />
        </div>
      )}
    </li>
  )
}

const CHOICE_LABEL: Record<ConflictChoice, string> = { skip: "Keep this computer's copy", replace: "Replace with the archive's copy" }

function ConflictChoices({ title, choice, onChoose }: { title: string; choice: ConflictChoice; onChoose: (choice: ConflictChoice) => void }) {
  return (
    <span className="plan-choice">
      <span className="chips" role="group" aria-label={`What to do with ${title}`}>
        {(['skip', 'replace'] as const).map((option) => (
          <button key={option} type="button" aria-pressed={choice === option} onClick={() => onChoose(option)}>
            {CHOICE_LABEL[option]}
          </button>
        ))}
      </span>
      {choice === 'replace' && <span className="plan-choice-note">The copy on this computer goes to the backup folder first.</span>}
    </span>
  )
}

function ConflictBar({ keys, choices, onChoose }: { keys: SessionKey[]; choices: ReadonlyMap<SessionKey, ConflictChoice>; onChoose: Props['onChoose'] }) {
  const replacing = keys.filter((key) => conflictChoice(choices, key) === 'replace').length
  return (
    <div className="plan-bulk">
      <span>
        {plural(keys.length, 'session')} already {keys.length === 1 ? 'has' : 'have'} a different copy on this computer.{' '}
        <span className="dim">{replacing === 0 ? 'Import keeps every copy here.' : `${replacing} will be replaced.`}</span>
      </span>
      <span className="plan-bulk-actions">
        <button type="button" className="button small" disabled={replacing === 0} onClick={() => onChoose(keys, 'skip')}>
          Keep all
        </button>
        <button type="button" className="button small" disabled={replacing === keys.length} onClick={() => onChoose(keys, 'replace')}>
          Replace all
        </button>
      </span>
    </div>
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
