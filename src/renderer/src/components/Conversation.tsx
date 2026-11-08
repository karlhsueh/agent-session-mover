import type { PreviewCounts, PreviewMessage, SessionPreview } from '../../../shared/sessions'
import { absoluteTime, plural } from '../model/format'
import type { Loadable } from '../state'
import { ErrorBanner } from './common'

function countText(counts: PreviewCounts, complete: boolean): string {
  const parts = [counts.messages > 0 && plural(counts.messages, 'message'), counts.toolCalls > 0 && plural(counts.toolCalls, 'tool call')].filter(Boolean)
  return `${complete ? '' : 'At least '}${parts.join(', ')}`
}

function gapText(omitted: PreviewCounts, complete: boolean): string {
  const parts = [omitted.messages > 0 && plural(omitted.messages, 'earlier message'), omitted.toolCalls > 0 && plural(omitted.toolCalls, 'tool call')].filter(Boolean)
  if (parts.length === 0) return 'Earlier messages left out'
  return `${complete ? '' : 'At least '}${parts.join(', ')}`
}

const ROLE_LABEL = { user: 'Prompt', assistant: 'Reply', tool: 'Tool call' } as const

function Entry({ entry }: { entry: PreviewMessage }) {
  const when = entry.at ? absoluteTime(entry.at) : undefined
  if (entry.kind === 'tool') {
    return (
      <li className="turn turn-tool" aria-label={`${ROLE_LABEL.tool}: ${entry.summary}`} title={when ? `${entry.name} · ${when}` : entry.name}>
        <span className="truncate">{entry.summary}</span>
      </li>
    )
  }
  return (
    <li className={`turn turn-${entry.kind}`} aria-label={ROLE_LABEL[entry.kind]} title={when}>
      {entry.text}
    </li>
  )
}

/** What a session said: its first entry, how much is left out, then its newest entries. Plain text only. */
export function Conversation({ state, onRetry }: { state: Loadable<SessionPreview> | null; onRetry: () => void }) {
  if (!state || state.status === 'loading') {
    return (
      <p className="conversation-status dim" role="status">
        Reading the conversation…
      </p>
    )
  }
  if (state.status === 'failed') {
    return (
      <div className="conversation-status">
        <ErrorBanner error={state.error} />
        <button type="button" className="button small" onClick={onRetry}>
          Try again
        </button>
      </div>
    )
  }
  const preview = state.value
  if (preview.kind === 'unavailable') return <p className="conversation-status dim">{preview.reason}</p>
  const hidden = preview.omitted.messages + preview.omitted.toolCalls
  return (
    <div className="conversation">
      <ol className="turns" aria-label="Conversation">
        <Entry entry={preview.first} />
        {(hidden > 0 || !preview.complete) && <li className="turns-gap">{gapText(preview.omitted, preview.complete)}</li>}
        {preview.recent.map((entry, index) => (
          <Entry key={index} entry={entry} />
        ))}
      </ol>
      <p className="conversation-counts dim small">{countText(preview.counts, preview.complete)}</p>
    </div>
  )
}
