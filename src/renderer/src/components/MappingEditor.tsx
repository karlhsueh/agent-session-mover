import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { type ArchiveSummary, type ArchiveToken, type ConflictChoice, type ImportPreview, isAtOrUnder, type PathMapping, type SessionInfo, type SessionKey } from '../../../shared/sessions'
import { useHomeDir } from '../hooks'
import { branchesLabel, branchList, expandTilde, folderName, plural, tildePath } from '../model/format'
import { type CloneTarget, cloneTarget, conflictChoice, missingFolderHint, receivesFiles } from '../model/importing'
import { HintLine } from './ImportParts'

interface Props {
  token: ArchiveToken
  mappings: PathMapping[]
  sessions: readonly SessionInfo[]
  preview: ImportPreview | null
  choices: ReadonlyMap<SessionKey, ConflictChoice>
  /** True while main plans again, so the shown statuses may be stale. */
  checking: boolean
  /** The source machine's home folder, shown as ~ in source paths. */
  sourceHome: string
  /** The source machine's path separator, for telling which folders sit inside a mapped one. */
  sourceSep: string
  /** Repos on the source computer, for a clone command when a folder is missing here. */
  repos: ArchiveSummary['source']['repos']
  onChange: (source: string, target: string) => void
}

const ABSOLUTE = /^(\/|[A-Za-z]:[\\/]|\\\\)/

type FolderStatus = 'exists' | 'missing' | 'unknown'

/** Main reports a missing folder only for a session's starting cwd, so folders no session started in stay unknown. */
function folderStatus(mapping: PathMapping, sessions: readonly SessionInfo[], preview: ImportPreview | null, sep: string): FolderStatus {
  if (!preview || !sessions.some((session) => session.cwd !== null && isAtOrUnder(session.cwd, mapping.source, sep))) return 'unknown'
  const trimmed = mapping.target.replace(/[\\/]+$/, '')
  const missing = preview.sessions.flatMap((session) => session.warnings.flatMap((warning) => (warning.code === 'target-cwd-missing' ? [warning.path] : [])))
  if (missing.includes(trimmed)) return 'missing'
  // A missing subfolder belongs to its session's warning. Create folder here would only make this folder.
  if (missing.some((path) => path.startsWith(`${trimmed}/`) || path.startsWith(`${trimmed}\\`))) return 'unknown'
  return 'exists'
}

const STATUS_TEXT: Record<FolderStatus, string> = { exists: 'Folder exists', missing: 'Folder does not exist yet', unknown: '' }

type Creation = { kind: 'idle' } | { kind: 'creating' } | { kind: 'failed'; message: string }
const IDLE: Creation = { kind: 'idle' }

export function MappingEditor({ token, mappings, sessions, preview, choices, checking, sourceHome, sourceSep, repos, onChange }: Props) {
  const home = useHomeDir()
  const [showAll, setShowAll] = useState(false)
  const rows = mappings.map((mapping) => {
    const users = sessions.filter((session) => session.cwds.some((cwd) => isAtOrUnder(cwd, mapping.source, sourceSep)))
    return { mapping, users, needed: needsMapping(users, preview, choices) }
  })
  const needed = rows.filter((row) => row.needed)
  const announcement = useNewlyNeeded(preview ? needed.map((row) => row.mapping.source) : null)
  if (rows.length === 0) return null
  const hidden = rows.length - needed.length
  const shownRows = showAll ? rows : needed
  // The panel stays when no folder receives files, as one line, so a choice below never makes it appear.
  return (
    <section className={shownRows.length === 0 ? 'panel folders-idle' : 'panel'} aria-labelledby="mapping-heading">
      <p className="visually-hidden" aria-live="polite">
        {announcement}
      </p>
      <header className="panel-head">
        <h2 id="mapping-heading">Folders</h2>
        {shownRows.length > 0 && (
          <p className="dim">Pull or copy each project into its folder here before you resume, so the agent finds its code. Import places each session by the folder it started in.</p>
        )}
      </header>
      <ul className="mappings">
        {shownRows.map(({ mapping, users }) => (
          <MappingRow
            key={mapping.source}
            token={token}
            mapping={mapping}
            sourceHome={sourceHome}
            home={home}
            uses={users.length}
            branches={users}
            status={folderStatus(mapping, sessions, preview, sourceSep)}
            clone={cloneTarget(repos, mapping.source, mappings, sourceSep, home)}
            checking={checking}
            onChange={onChange}
          />
        ))}
      </ul>
      {hidden > 0 && (
        <div className="mappings-more">
          <button type="button" className="button ghost small" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
            {showAll ? 'Show only folders that receive files' : `Show ${plural(hidden, needed.length > 0 ? 'other folder' : 'folder')}`}
          </button>
          {!showAll && (
            <span className="dim">
              {needed.length === 0 ? 'Import writes no files into them as the screen stands.' : `${hidden === 1 ? 'Its sessions are' : 'Their sessions are'} already here or blocked, so import writes nothing there.`}
            </span>
          )}
        </div>
      )}
    </section>
  )
}

/** A polite line naming each folder that just started to receive files, such as after a Replace below. */
function useNewlyNeeded(sources: readonly string[] | null): string {
  const previous = useRef<readonly string[] | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const key = sources?.join('\n') ?? null
  useEffect(() => {
    const before = previous.current
    previous.current = sources
    if (!before || !sources) return
    const added = sources.filter((source) => !before.includes(source))
    if (added.length > 0) setAnnouncement(`${added.map((source) => folderName(source)).join(', ')} now ${added.length === 1 ? 'receives' : 'receive'} files. See Folders above.`)
  }, [key])
  return announcement
}

/** Before the first plan arrives every folder is shown, since nothing is known yet. */
function needsMapping(users: readonly SessionInfo[], preview: ImportPreview | null, choices: ReadonlyMap<SessionKey, ConflictChoice>): boolean {
  if (!preview) return true
  const actions = new Map(preview.sessions.map((session) => [session.key, session.action]))
  return users.some((session) => {
    const action = actions.get(session.key)
    return action === undefined || receivesFiles(action, conflictChoice(choices, session.key))
  })
}

function MappingRow({
  token,
  mapping,
  sourceHome,
  home,
  uses,
  branches: users,
  status,
  clone,
  checking,
  onChange,
}: {
  token: ArchiveToken
  mapping: PathMapping
  sourceHome: string
  /** This machine's home folder. The field shows it as ~ and expands ~ back before sending a path to main. */
  home: string
  uses: number
  /** The folder's sessions, for the branches they were on, so the user knows what to check out here. */
  branches: readonly SessionInfo[]
  status: FolderStatus
  clone: CloneTarget | null
  checking: boolean
  onChange: Props['onChange']
}) {
  const branches = branchesLabel(users)
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
      {offerCreate && (
        <div className="mapping-hint">
          <HintLine hint={missingFolderHint(branchList(users), clone, home)} />
        </div>
      )}
    </li>
  )
}

