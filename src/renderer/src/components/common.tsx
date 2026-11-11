import { Fragment, useEffect, useState, type ReactNode } from 'react'
import type { ApiError } from '../../../shared/ipc'
import type { AgentId, ClientKind } from '../../../shared/sessions'
import { AGENT_LABEL, CLIENT_LABEL, MOD } from '../model/format'
import { matchParts } from '../model/rows'

const ERROR_LEAD: Record<ApiError['code'], string> = {
  busy: 'Another export or import is still running.',
  'invalid-archive': 'This file is not a valid Agent Session Mover archive.',
  'unknown-archive': 'That archive was closed. Open it again.',
  'invalid-input': 'Agent Session Mover rejected the request.',
  io: 'Something went wrong reading or writing files.',
}

export function ErrorBanner({ error, onDismiss }: { error: ApiError; onDismiss?: () => void }) {
  const detail = error.code === 'busy' || error.code === 'unknown-archive' ? null : error.message
  return (
    <div className="banner banner-error" role="alert">
      <div>
        <strong>{ERROR_LEAD[error.code]}</strong>
        {detail && <span className="banner-detail">{detail}</span>}
      </div>
      {onDismiss && (
        <button type="button" className="button ghost small" onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </div>
  )
}

/** `label` names the button for a screen reader too when given, so a long `text` is not read aloud. */
export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1400)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <button
      type="button"
      className="button ghost small"
      aria-label={copied ? 'Copied' : (label ?? `Copy: ${text}`)}
      onClick={async () => {
        await window.api.copyText(text)
        setCopied(true)
      }}
    >
      {copied ? 'Copied' : (label ?? 'Copy')}
    </button>
  )
}

/**
 * Wraps only at spaces, and first after `&&`, so `cd <folder> &&` and the agent command stay whole
 * when they fit. Browsers also break after hyphens, which would split a UUID or `--resume`.
 */
export function CommandText({ command }: { command: string }) {
  const steps = command.split(' && ')
  return (
    <code>
      {steps.map((step, index) => (
        <Fragment key={index}>
          {index > 0 && ' '}
          <span className="command-step">
            {`${step}${index < steps.length - 1 ? ' &&' : ''}`.split(' ').map((word, at) => (
              <Fragment key={at}>
                {at > 0 && ' '}
                <span className="nowrap">{word}</span>
              </Fragment>
            ))}
          </span>
        </Fragment>
      ))}
    </code>
  )
}

/** A path that wraps only after a separator, never inside a folder name. */
export function PathText({ path }: { path: string }) {
  return (
    <>
      {path.split(/(?<=[\\/])/).map((part, index) => (
        <Fragment key={index}>
          {index > 0 && <wbr />}
          <span className="nowrap">{part}</span>
        </Fragment>
      ))}
    </>
  )
}

export function CommandLine({ command }: { command: string }) {
  return (
    <div className="command">
      <CommandText command={command} />
      <CopyButton text={command} />
    </div>
  )
}

export function ProgressBar({ value, label }: { value: number | null; label: string }) {
  const percent = value === null ? null : Math.round(Math.min(Math.max(value, 0), 1) * 100)
  return (
    <div
      className={percent === null ? 'progress indeterminate' : 'progress'}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
    >
      <div style={{ width: percent === null ? undefined : `${percent}%` }} />
    </div>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>
}

export function Sheet({ label, children, onClose }: { label: string; children: ReactNode; onClose?: () => void }) {
  useEffect(() => {
    if (!onClose) return
    const close = onClose
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div className="scrim">
      <div className="sheet" role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>
  )
}

/** A circle for Claude Code and a square for Codex, so the two differ without color too. */
export function AgentMark({ agent, client }: { agent: AgentId; client?: ClientKind }) {
  const label = client ? `${AGENT_LABEL[agent]} · ${CLIENT_LABEL[client]}` : AGENT_LABEL[agent]
  return <span className={`mark mark-${agent}`} role="img" aria-label={label} title={label} />
}

export function Highlight({ text, needle }: { text: string; needle: string }) {
  return (
    <>
      {matchParts(text, needle).map((part, index) => (part.match ? <mark key={index}>{part.text}</mark> : part.text))}
    </>
  )
}

/** Lists the stores again. Main reads only what changed, so it is quick unless a long session grew. */
export function RefreshButton({ refreshing, onRefresh }: { refreshing: boolean; onRefresh: () => void }) {
  return (
    <button type="button" className="button ghost icon" aria-label="Refresh sessions" aria-busy={refreshing} title={`Refresh (${MOD}R)`} onClick={onRefresh}>
      <svg className={refreshing ? 'spin' : undefined} width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M13.3 6.2A5.5 5.5 0 0 0 3 5.1M2.7 9.8A5.5 5.5 0 0 0 13 10.9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M3 2.2v2.9h2.9M13 13.8v-2.9h-2.9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}
