import type { ConflictChoice, SessionImportPreview, SessionInfo, SessionKey, SessionPreview } from '../../../shared/sessions'
import { AGENT_LABEL, folderName, plural, sessionTitle } from '../model/format'
import { conflictChoice, describeAction, isActionable, planBadge, warningText, willImport } from '../model/importing'
import type { Loadable } from '../state'
import { Conversation } from './Conversation'

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

export function PlanRow({ session, plan, included, onToggle, choice, onChoose, conversation, onConversation, onRetry, home, listedFolders }: PlanRowProps) {
  const actionable = plan !== null && isActionable(plan.action)
  const conflict = plan?.action.kind === 'conflict'
  const id = `plan-${session.key}`
  const shown = conversation !== undefined
  const live = plan !== null && willImport(plan.action, included, choice)
  // Warnings are about resuming, so a row that imports nothing whatever the tick says has none.
  const warnings = actionable || (conflict && choice === 'replace') ? (plan?.warnings ?? []) : []
  const badge = plan && planBadge(plan.action, choice)
  // Only an add or update can be ticked. A row nothing happens to gets no checkbox, rather than a disabled one.
  const Main = actionable ? 'label' : 'div'
  return (
    <li className={`${live ? 'plan-row' : 'plan-row inert'}${shown ? ' expanded' : ''}`} data-key={session.key}>
      {actionable ? <input id={id} type="checkbox" checked={included} onChange={() => onToggle(session.key)} /> : <span aria-hidden="true" />}
      <span className="plan-badge">{badge && <span className={`badge tone-${badge.tone}`}>{badge.label}</span>}</span>
      <Main htmlFor={actionable ? id : undefined} className="plan-main">
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

export function ConflictBar({
  keys,
  choices,
  onChoose,
}: {
  keys: SessionKey[]
  choices: ReadonlyMap<SessionKey, ConflictChoice>
  onChoose: (keys: readonly SessionKey[], choice: ConflictChoice) => void
}) {
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
