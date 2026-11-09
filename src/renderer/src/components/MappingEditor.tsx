import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ArchiveToken, ImportPreview, PathMapping, SessionInfo } from '../../../shared/sessions'
import { useHomeDir } from '../hooks'
import { branchesLabel, expandTilde, folderName, plural, tildePath } from '../model/format'

interface Props {
  token: ArchiveToken
  mappings: PathMapping[]
  sessions: readonly SessionInfo[]
  preview: ImportPreview | null
  /** True while main plans again, so the shown statuses may be stale. */
  checking: boolean
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

type Creation = { kind: 'idle' } | { kind: 'creating' } | { kind: 'failed'; message: string }
const IDLE: Creation = { kind: 'idle' }

export function MappingEditor({ token, mappings, sessions, preview, checking, sourceHome, onChange }: Props) {
  const home = useHomeDir()
  return (
    <section className="panel" aria-labelledby="mapping-heading">
      <header className="panel-head">
        <h2 id="mapping-heading">Folders</h2>
        <p className="dim">Pull or copy each project into its folder here before you resume, so the agent finds its code. Sessions are placed by the folder they started in.</p>
      </header>
      <ul className="mappings">
        {mappings.map((mapping) => {
          const users = sessions.filter((session) => session.cwds.includes(mapping.source))
          return (
            <MappingRow
              key={mapping.source}
              token={token}
              mapping={mapping}
              sourceHome={sourceHome}
              home={home}
              uses={users.length}
              branches={branchesLabel(users)}
              status={folderStatus(mapping, sessions, preview)}
              checking={checking}
              onChange={onChange}
            />
          )
        })}
      </ul>
    </section>
  )
}

function MappingRow({
  token,
  mapping,
  sourceHome,
  home,
  uses,
  branches,
  status,
  checking,
  onChange,
}: {
  token: ArchiveToken
  mapping: PathMapping
  sourceHome: string
  /** This machine's home folder. The field shows it as ~ and expands ~ back before sending a path to main. */
  home: string
  uses: number
  /** The branches the folder's sessions were on, so the user knows what to check out here. */
  branches: string | null
  status: FolderStatus
  checking: boolean
  onChange: Props['onChange']
}) {
  const shown = tildePath(mapping.target, home)
  const [draft, setDraft] = useState(shown)
  const [creation, setCreation] = useState<Creation>(IDLE)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    setDraft(shown)
    setCreation(IDLE)
  }, [shown])
  useLayoutEffect(() => {
    // The end of a path names the folder, so a long one shows its tail.
    if (input.current && document.activeElement !== input.current) input.current.scrollLeft = input.current.scrollWidth
  }, [draft])
  const next = expandTilde(draft.trim(), home)
  const invalid = next !== '' && !ABSOLUTE.test(next)
  const commit = () => {
    if (next !== mapping.target && next !== '' && !invalid) onChange(mapping.source, next)
  }
  const inputId = `target-${mapping.source}`
  const create = async () => {
    setCreation({ kind: 'creating' })
    const result = await window.api.createFolder(token, mapping.target)
    if (!result.ok) return setCreation({ kind: 'failed', message: result.error.message })
    setCreation(IDLE)
    onChange(mapping.source, mapping.target)
  }
  const failed = creation.kind === 'failed' ? creation.message : null
  const offerCreate = status === 'missing' && !invalid && next === mapping.target
  const warn = invalid || failed !== null || status === 'missing'

  return (
    <li className="mapping">
      <div className="mapping-source" title={mapping.source}>
        <span className="mapping-name">
          {folderName(mapping.source)} <span className="dim">· {plural(uses, 'session')}</span>
        </span>
        <span className="mapping-path truncate dim" title={branches ? `${mapping.source} on ${branches}` : mapping.source}>
          <code>{tildePath(mapping.source, sourceHome)}</code>
          {branches && (
            <>
              {' on '}
              <code className="mapping-branches">{branches}</code>
            </>
          )}
        </span>
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
          title={mapping.target}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
            if (event.key === 'Escape') setDraft(shown)
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
        <div className={warn ? 'mapping-note warn' : 'mapping-note'}>
          <span className="mapping-status" aria-live="polite">
            {invalid ? 'Use a full path' : (failed ?? STATUS_TEXT[status])}
          </span>
          {offerCreate && (
            <button type="button" className="button small" disabled={checking || creation.kind === 'creating'} onClick={create}>
              {creation.kind === 'creating' ? 'Creating…' : 'Create folder'}
            </button>
          )}
        </div>
      </div>
    </li>
  )
}
