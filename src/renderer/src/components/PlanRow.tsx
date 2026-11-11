import type { ConflictChoice, SessionImportPreview, SessionInfo, SessionKey, SessionPreview } from '../../../shared/sessions'
import { AGENT_LABEL, folderName, plural, sessionTitle } from '../model/format'
import { conflictChoice, type CopyLine, copyLines, describeAction, hereIsAhead, isActionable, planBadge, warningText, willImport } from '../model/importing'
import type { ProjectLabel } from '../model/scope'
import type { Loadable } from '../state'
import { Conversation } from './Conversation'

type Side = 'archive' | 'here'
/** Undefined while that conversation is folded away. */
type Shown = Loadable<SessionPreview> | null | undefined

interface PlanRowProps {
  session: SessionInfo
  /** How browse would name the session's folder, so two folders called `api` read apart. */
  folderLabel: ProjectLabel | undefined
  plan: SessionImportPreview | null
  /** False when no row on the screen has a checkbox, so none keeps an empty column for one. */
  checks: boolean
  included: boolean
  onToggle: (key: SessionKey) => void
  choice: ConflictChoice
  /** False until the user picks Keep or Replace for a conflict. Import keeps the copy here until then. */
  decided: boolean
  onChoose: (choice: ConflictChoice) => void
  conversation: Shown
  /** This computer's copy of a conflicting session. */
  here: Shown
  onConversation: (side: Side) => void
  onRetry: (side: Side) => void
  home: string
  /** Mapping targets, which the Folders section already flags when missing. */
  listedFolders: ReadonlySet<string>
}

export function PlanRow(props: PlanRowProps) {
  const { session, folderLabel, plan, checks, included, onToggle, choice, decided, onChoose, conversation, here, onConversation, onRetry, home, listedFolders } = props
  const actionable = plan !== null && isActionable(plan.action)
  const conflict = plan?.action.kind === 'conflict'
  const id = `plan-${session.key}`
  const title = sessionTitle(session)
  const live = plan !== null && willImport(plan.action, included, choice)
  // Warnings are about resuming, so a row that imports nothing whatever the tick says has none.
  const warnings = actionable || (conflict && choice === 'replace') ? (plan?.warnings ?? []) : []
  const badge = plan && planBadge(plan.action, choice)
  // Only an add or update can be ticked. A row nothing happens to gets no checkbox, rather than a disabled one.
  const Main = actionable ? 'label' : 'div'
  const shown = conversation !== undefined || here !== undefined
  const label = folderLabel ?? { name: folderName(session.cwd), parent: null }
  const previewButton = (side: Side, state: Shown, text: string, what: string) => (
    <button
      type="button"
      className="button ghost small"
      aria-label={`${state !== undefined ? 'Hide' : 'Preview'} ${what} of ${title}`}
      aria-expanded={state !== undefined}
      aria-controls={`${id}-${side}`}
      onClick={() => onConversation(side)}
    >
      {[state !== undefined ? 'Hide' : 'Preview', text].filter(Boolean).join(' ')}
    </button>
  )
  return (
    <li className={`${live ? 'plan-row' : 'plan-row inert'}${shown ? ' expanded' : ''}${checks ? '' : ' no-check'}`} data-key={session.key}>
      {checks && (actionable ? <input id={id} type="checkbox" checked={included} onChange={() => onToggle(session.key)} /> : <span aria-hidden="true" />)}
      <span className="plan-badge">{badge && <span className={`badge tone-${badge.tone}`}>{badge.label}</span>}</span>
      <Main htmlFor={actionable ? id : undefined} className="plan-main">
        <span className="plan-title">
          <span className="truncate">{title}</span>
        </span>
        <span className="plan-meta dim">
          {AGENT_LABEL[session.agent]} ·{' '}
          <span title={session.cwd ?? undefined}>
            {label.name}
            {label.parent && <span className="scope-parent"> {label.parent}</span>}
          </span>
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
        {plan?.action.kind === 'conflict' && <CopyCompare lines={copyLines(plan.action)} />}
        {warnings.map((warning) => (
          <span key={warning.code} className="plan-warning">
            {warningText(warning, session.agent, home, warning.code === 'target-cwd-missing' && listedFolders.has(warning.path))}
          </span>
        ))}
        {conflict && <ConflictChoices title={title} choice={decided ? choice : null} ahead={hereIsAhead(plan.action)} onChoose={onChoose} />}
      </Main>
      <span className={conflict ? 'plan-side stacked' : 'plan-side'}>
        {conflict ? (
          <>
            {previewButton('here', here, "this computer's copy", "this computer's copy")}
            {previewButton('archive', conversation, "archive's copy", "the archive's copy")}
          </>
        ) : (
          previewButton('archive', conversation, '', 'the conversation')
        )}
      </span>
      {here !== undefined && <ConversationPanel id={`${id}-here`} label={"This computer's copy"} state={here} onRetry={() => onRetry('here')} />}
      {conversation !== undefined && <ConversationPanel id={`${id}-archive`} label={conflict ? "Archive's copy" : null} state={conversation} onRetry={() => onRetry('archive')} />}
    </li>
  )
}

function ConversationPanel({ id, label, state, onRetry }: { id: string; label: string | null; state: Loadable<SessionPreview> | null; onRetry: () => void }) {
  return (
    <div className="plan-conversation" id={id}>
      {label && <p className="plan-conversation-label">{label}</p>}
      <Conversation state={state} onRetry={onRetry} />
    </div>
  )
}

const CHOICE_LABEL: Record<ConflictChoice, string> = { skip: "Keep this computer's copy", replace: "Replace with the archive's copy" }

function ConflictChoices({ title, choice, ahead, onChoose }: { title: string; choice: ConflictChoice | null; ahead: boolean; onChoose: (choice: ConflictChoice) => void }) {
  return (
    <span className="plan-choice">
      <span className={`chips${ahead ? ' warn' : ''}${choice === null ? ' undecided' : ''}`} role="group" aria-label={`What to do with ${title}`}>
        {(['skip', 'replace'] as const).map((option) => (
          <button key={option} type="button" aria-pressed={choice === option} onClick={() => onChoose(option)}>
            {CHOICE_LABEL[option]}
          </button>
        ))}
      </span>
      {choice === 'replace' && (
        <span className={ahead ? 'plan-choice-note warn' : 'plan-choice-note'}>
          {ahead ? 'The copy here has newer messages. They go to the backup folder with the rest of that copy.' : 'The copy on this computer goes to the backup folder first.'}
        </span>
      )}
      {choice === null && <span className="plan-choice-note">Until you choose, import keeps this computer's copy.</span>}
    </span>
  )
}

/** This computer's copy and the archive's, counted the same way, with what each has over the other. */
function CopyCompare({ lines }: { lines: CopyLine[] }) {
  if (lines.length === 0) return null
  return (
    <dl className="copies">
      {lines.map((line) => {
        const notes = [line.more, line.newer ? 'newer' : null].filter(Boolean)
        return (
          <div key={line.label} className={notes.length > 0 ? 'copy ahead' : 'copy'}>
            <dt>{line.label}</dt>
            <dd>
              {line.text}
              {notes.length > 0 && <span className="copy-more"> · {notes.join(', ')}</span>}
            </dd>
          </div>
        )
      })}
    </dl>
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
  const keeping = keys.filter((key) => choices.get(key) === 'skip').length
  return (
    <div className="plan-bulk">
      <span>
        {plural(keys.length, 'session')} already {keys.length === 1 ? 'has' : 'have'} a different copy on this computer.{' '}
        <span className="dim">{replacing === 0 ? 'Import keeps every copy here.' : `${replacing} will be replaced.`}</span>
      </span>
      <span className="plan-bulk-actions">
        <button type="button" className="button small" disabled={keeping === keys.length} onClick={() => onChoose(keys, 'skip')}>
          Keep all
        </button>
        <button type="button" className="button small" disabled={replacing === keys.length} onClick={() => onChoose(keys, 'replace')}>
          Replace all
        </button>
      </span>
    </div>
  )
}
