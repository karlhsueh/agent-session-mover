import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ImportPreview, PathMapping, SessionInfo } from '../../../shared/sessions'
import { folderName, plural, tildePath } from '../model/format'

interface Props {
  mappings: PathMapping[]
  sessions: readonly SessionInfo[]
  preview: ImportPreview | null
  /** The source machine's home folder, shown as ~ in source paths. */
  sourceHome: string
  onChange: (source: string, target: string) => void
}

const ABSOLUTE = /^(\/|[A-Za-z]:[\\/]|\\\\)/

type FolderStatus = 'exists' | 'missing' | 'unknown'

/** Main reports a missing folder only for a session's starting cwd, so other folders stay unknown. */
function folderStatus(mapping: PathMapping, sessions: readonly SessionInfo[], preview: ImportPreview | null): FolderStatus {
  if (!preview || !sessions.some((session) => session.cwd === mapping.source)) return 'unknown'
  const trimmed = mapping.target.replace(/[\\/]+$/, '')
  const missing = preview.sessions.some((session) =>
    session.warnings.some((warning) => warning.code === 'target-cwd-missing' && (warning.path === trimmed || warning.path.startsWith(`${trimmed}/`) || warning.path.startsWith(`${trimmed}\\`))),
  )
  return missing ? 'missing' : 'exists'
}

const STATUS_TEXT: Record<FolderStatus, string> = { exists: 'Folder exists', missing: 'Folder does not exist yet', unknown: '' }

export function MappingEditor({ mappings, sessions, preview, sourceHome, onChange }: Props) {
  return (
    <section className="panel" aria-labelledby="mapping-heading">
      <header className="panel-head">
        <h2 id="mapping-heading">Folders</h2>
        <p className="dim">Each folder from the other machine becomes a folder here. Sessions are placed by the folder they started in.</p>
      </header>
      <ul className="mappings">
        {mappings.map((mapping) => (
          <MappingRow
            key={mapping.source}
            mapping={mapping}
            sourceHome={sourceHome}
            uses={sessions.filter((session) => session.cwds.includes(mapping.source)).length}
            status={folderStatus(mapping, sessions, preview)}
            onChange={onChange}
          />
        ))}
      </ul>
    </section>
  )
}

function MappingRow({
  mapping,
  sourceHome,
  uses,
  status,
  onChange,
}: {
  mapping: PathMapping
  sourceHome: string
  uses: number
  status: FolderStatus
  onChange: Props['onChange']
}) {
  const [draft, setDraft] = useState(mapping.target)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => setDraft(mapping.target), [mapping.target])
  useLayoutEffect(() => {
    // The end of a path names the folder, so a long one shows its tail.
    if (input.current && document.activeElement !== input.current) input.current.scrollLeft = input.current.scrollWidth
  }, [draft])
  const invalid = draft.trim() !== '' && !ABSOLUTE.test(draft.trim())
  const commit = () => {
    const next = draft.trim()
    if (next !== mapping.target && next !== '' && !invalid) onChange(mapping.source, next)
  }
  const inputId = `target-${mapping.source}`

  return (
    <li className="mapping">
      <div className="mapping-source" title={mapping.source}>
        <span className="mapping-name">
          {folderName(mapping.source)} <span className="dim">· {plural(uses, 'session')}</span>
        </span>
        <code className="truncate dim">{tildePath(mapping.source, sourceHome)}</code>
      </div>
      <span className="mapping-arrow" aria-hidden="true">
        →
      </span>
      <div className="mapping-target">
        <label className="visually-hidden" htmlFor={inputId}>
          Folder on this machine for {mapping.source}
        </label>
        <input
          ref={input}
          id={inputId}
          className={invalid ? 'mono invalid' : 'mono'}
          value={draft}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
            if (event.key === 'Escape') setDraft(mapping.target)
          }}
          aria-invalid={invalid}
        />
        <button
          type="button"
          className="button small"
          onClick={async () => {
            const folder = await window.api.chooseFolder(mapping.target)
            if (folder) onChange(mapping.source, folder)
          }}
        >
          Choose…
        </button>
        <span className={invalid || status === 'missing' ? 'mapping-status warn' : 'mapping-status'} aria-live="polite">
          {invalid ? 'Use a full path' : STATUS_TEXT[status]}
        </span>
      </div>
    </li>
  )
}
