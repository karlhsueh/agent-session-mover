import { useState, type ReactNode } from 'react'
import type { FolderHint } from '../model/importing'
import { CommandText, CopyButton } from './common'

export function HintLine({ hint }: { hint: FolderHint }) {
  return (
    <span className="hint-line">
      <span>{hint.text}</span>
      {hint.command && (
        <span className="hint-command">
          <CommandText command={hint.command} />
          <CopyButton text={hint.command} label="Copy" />
        </span>
      )}
    </span>
  )
}

/** A quiet group that opens on demand, such as the sessions import leaves alone. */
export function Fold({ id, summary, children }: { id: string; summary: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={open ? 'fold open' : 'fold'}>
      <button type="button" className="fold-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>{summary}</span>
      </button>
      {open && (
        <div className="fold-body" id={id}>
          {children}
        </div>
      )}
    </div>
  )
}
