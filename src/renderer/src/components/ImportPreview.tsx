import { useCallback, useState } from 'react'
import type { ProgressEvent, SessionImportPreview, SessionInfo, SessionKey, SessionPreview } from '../../../shared/sessions'
import { usePreviews } from '../hooks'
import { AGENT_LABEL, folderName, platformLabel, plural, sessionTitle, shortDateTime } from '../model/format'
import { ACTIONS, describeAction, isActionable, selectedForImport, warningText } from '../model/importing'
import { type Loadable, shownPreview, type PreviewScreen } from '../state'
import { ErrorBanner, ProgressBar, Sheet } from './common'
import { Conversation } from './Conversation'
import { MappingEditor } from './MappingEditor'

interface Props {
  screen: PreviewScreen
  onMappingChange: (source: string, target: string) => void
  onToggle: (key: SessionKey) => void
  onRun: (keys: SessionKey[]) => void
  onBack: () => void
  onDismissError: () => void
}

export function ImportPreview({ screen, onMappingChange, onToggle, onRun, onBack, onDismissError }: Props) {
  const { archive, preview: state, excluded } = screen
  const preview = shownPreview(state)
  const byKey = new Map((preview?.sessions ?? []).map((session) => [session.key, session]))
  const sessions = [...archive.summary.sessions].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
  const keys = selectedForImport(preview, excluded)
  const counts = new Map<string, number>()
  for (const session of preview?.sessions ?? []) counts.set(session.action.kind, (counts.get(session.action.kind) ?? 0) + 1)
  const token = archive.token
  const [conversation, requestConversation] = usePreviews(useCallback((key: SessionKey) => window.api.previewArchiveSession(token, key), [token]), token)
  const [open, setOpen] = useState<ReadonlySet<SessionKey>>(new Set())
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
          <h1>Import {archive.summary.fileName}</h1>
          <p className="dim" title={`Home folder on that machine: ${archive.summary.source.homeDir}`}>
            {plural(archive.summary.sessions.length, 'session')} · exported from {platformLabel(archive.summary.source.platform)} on{' '}
            {shortDateTime(archive.summary.createdAt)}
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
          onChange={onMappingChange}
        />

        <section className="panel" aria-labelledby="sessions-heading" aria-busy={state.status === 'loading'}>
          <header className="panel-head row-between">
            <h2 id="sessions-heading">Sessions</h2>
            <p className="dim summary-counts">
              {state.status === 'loading'
                ? 'Checking this machine…'
                : (Object.keys(ACTIONS) as (keyof typeof ACTIONS)[])
                    .filter((kind) => counts.has(kind))
                    .map((kind) => `${counts.get(kind)} ${ACTIONS[kind].label.toLowerCase()}`)
                    .join(' · ')}
            </p>
          </header>
          <ul className={state.status === 'loading' ? 'plan stale' : 'plan'}>
            {sessions.map((session) => (
              <PlanRow
                key={session.key}
                session={session}
                plan={byKey.get(session.key) ?? null}
                included={!excluded.has(session.key)}
                onToggle={onToggle}
                conversation={open.has(session.key) ? conversation(session.key) : undefined}
                onConversation={() => toggleOpen(session.key)}
                onRetry={() => requestConversation(session.key)}
              />
            ))}
          </ul>
        </section>
      </div>

      <footer className="statusbar">
        <span className="dim">Files are written only after you start the import. An update keeps a backup of the copy it replaces.</span>
        <span className="statusbar-actions">
          <button type="button" className="button" onClick={onBack}>
            Cancel
          </button>
          <button type="button" className="button primary" disabled={keys.length === 0 || state.status !== 'ready'} onClick={() => onRun(keys)}>
            {keys.length > 0 ? `Import ${plural(keys.length, 'session')}` : 'Nothing to import'}
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
  /** Undefined while the conversation is folded away. */
  conversation: Loadable<SessionPreview> | null | undefined
  onConversation: () => void
  onRetry: () => void
}

function PlanRow({ session, plan, included, onToggle, conversation, onConversation, onRetry }: PlanRowProps) {
  const actionable = plan !== null && isActionable(plan.action)
  const id = `plan-${session.key}`
  const shown = conversation !== undefined
  return (
    <li className={`${actionable ? 'plan-row' : 'plan-row inert'}${shown ? ' expanded' : ''}`}>
      <input id={id} type="checkbox" checked={actionable && included} disabled={!actionable} onChange={() => onToggle(session.key)} />
      <label htmlFor={id} className="plan-main">
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
        {plan && plan.action.kind !== 'create' && <span className="plan-message">{describeAction(plan.action)}</span>}
        {plan?.warnings.map((warning) => (
          <span key={warning.code} className="plan-warning">
            {warningText(warning, session.agent)}
          </span>
        ))}
      </label>
      <span className="plan-side">
        {plan && <span className={`badge tone-${ACTIONS[plan.action.kind].tone}`}>{ACTIONS[plan.action.kind].label}</span>}
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

export function ImportingSheet({ keys, progress, titles }: { keys: SessionKey[]; progress: ProgressEvent | null; titles: ReadonlyMap<SessionKey, string> }) {
  const running = progress?.operation === 'import' ? progress : null
  return (
    <Sheet label="Importing">
      <h2>Importing {plural(keys.length, 'session')}</h2>
      <ProgressBar value={running && running.total > 0 ? running.done / running.total : null} label="Import progress" />
      <p className="dim truncate">{running?.current ? titles.get(running.current) : running ? `${running.done} of ${running.total}` : 'Planning again…'}</p>
    </Sheet>
  )
}

export function OpeningSheet({ progress }: { progress: ProgressEvent | null }) {
  if (progress?.operation !== 'open') return null
  return (
    <Sheet label="Verifying archive">
      <h2>Verifying archive</h2>
      <ProgressBar value={progress.bytesTotal > 0 ? progress.bytesRead / progress.bytesTotal : null} label="Verify progress" />
      <p className="dim">Every file is checked against its hash before anything is shown.</p>
    </Sheet>
  )
}
