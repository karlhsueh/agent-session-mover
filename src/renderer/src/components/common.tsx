import { Fragment, useEffect, useState, type ReactNode } from 'react'
import type { ApiError } from '../../../shared/ipc'
import type { AgentId } from '../../../shared/sessions'
import { AGENT_LABEL } from '../model/format'
import { matchParts } from '../model/rows'

const ERROR_LEAD: Record<ApiError['code'], string> = {
  busy: 'Another export or import is still running.',
  'invalid-archive': 'This file is not a valid Agent Sessions archive.',
  'unknown-archive': 'That archive was closed. Open it again.',
  'invalid-input': 'The request was rejected.',
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

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
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
      aria-label={copied ? 'Copied' : `${label}: ${text}`}
      onClick={async () => {
        await window.api.copyText(text)
        setCopied(true)
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  )
}

/** Wraps only at spaces. Browsers also break after hyphens, which would split a UUID or `--resume`. */
export function CommandText({ command }: { command: string }) {
  return (
    <code>
      {command.split(' ').map((word, index) => (
        <Fragment key={index}>
          {index > 0 && ' '}
          <span className="nowrap">{word}</span>
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
export function AgentMark({ agent }: { agent: AgentId }) {
  return <span className={`mark mark-${agent}`} role="img" aria-label={AGENT_LABEL[agent]} title={AGENT_LABEL[agent]} />
}

export function Highlight({ text, needle }: { text: string; needle: string }) {
  return (
    <>
      {matchParts(text, needle).map((part, index) => (part.match ? <mark key={index}>{part.text}</mark> : part.text))}
    </>
  )
}
