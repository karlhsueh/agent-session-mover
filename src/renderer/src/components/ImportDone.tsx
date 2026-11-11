import { useHomeDir } from '../hooks'
import { AGENT_LABEL, plural, REVEAL_LABEL, tildePath } from '../model/format'
import { type CloneTarget, cloneTarget, existingFolderHint, missingFolderHint } from '../model/importing'
import { accountFor, type FolderGroup, quietSummary, type ResultEntry } from '../model/result'
import type { Screen } from '../state'
import { CommandLine, CopyButton } from './common'
import { Fold, HintLine } from './ImportParts'

type DoneScreen = Extract<Screen, { kind: 'import-done' }>

export function ImportDone({ screen, onDone }: { screen: DoneScreen; onDone: () => void }) {
  const { archive, result, plan } = screen
  const home = useHomeDir()
  const { groups, quiet, placed, failed } = accountFor(archive.summary.sessions, result, plan, home)
  const written = new Set(groups.flatMap((group) => group.entries.map((entry) => entry.key)))
  const placedAgents = new Set(archive.summary.sessions.filter((session) => written.has(session.key)).map((session) => AGENT_LABEL[session.agent]))
  const commands = groups.flatMap((group) => group.entries.flatMap((entry) => (entry.resume ? [entry.resume] : [])))
  const missing = groups.filter((group) => group.missing).length
  const { repos, sep } = archive.summary.source
  const groupClone = (group: FolderGroup) => group.sources.map((source) => cloneTarget(repos, source, screen.mappings, sep, home)).find(Boolean) ?? null

  return (
    <div className="import">
      <div className="import-scroll result">
        <header className="import-head result-head">
          <div className="result-title">
            <h1>{placed > 0 ? `${plural(placed, 'session')} imported` : 'Nothing was imported'}</h1>
            <p className="dim">
              {placed > 0 &&
                `Pull your latest changes into each folder, then run a resume command in a terminal. The files are where ${[...placedAgents].join(' and ')} looks for them, but Agent Session Mover cannot check that the agent opens them.`}
              {placed > 0 && missing > 0 && ` ${plural(missing, 'folder')} ${missing === 1 ? 'does' : 'do'} not exist yet.`}
              {failed > 0 && ` ${plural(failed, 'session')} did not import.`}
            </p>
          </div>
          <span className="result-actions">
            {commands.length > 1 && <CopyButton text={commands.join('\n')} label="Copy all commands" />}
            <button type="button" className="button primary" onClick={onDone} autoFocus>
              Back to sessions
            </button>
          </span>
        </header>

        {groups.map((group) => (
          <FolderPanel key={group.folder ?? ''} group={group} home={home} clone={group.missing ? groupClone(group) : null} />
        ))}

        {quiet.length > 0 && (
          <Fold id="result-quiet" summary={quietSummary(quiet)}>
            <ul className="plan quiet-list">
              {quiet.map((entry) => (
                <li key={entry.key} className="outcome quiet" data-key={entry.key}>
                  <OutcomeHead entry={entry} />
                  <span className="plan-message">
                    {entry.folder ? `${tildePath(entry.folder, home)} · ` : ''}
                    {entry.message}
                  </span>
                </li>
              ))}
            </ul>
          </Fold>
        )}

        {result.backupDir && (
          <p className="backups dim">
            <span className="truncate">
              Backups of replaced copies are in <code className="selectable">{tildePath(result.backupDir, home)}</code>
            </span>
            <button type="button" className="button ghost small" onClick={() => void window.api.revealBackups()}>
              {REVEAL_LABEL}
            </button>
          </p>
        )}
      </div>
    </div>
  )
}

function FolderPanel({ group, home, clone }: { group: FolderGroup; home: string; clone: CloneTarget | null }) {
  const id = `folder-${group.folder ?? 'none'}`
  return (
    <section className="panel" aria-labelledby={id}>
      <header className="panel-head folder-head">
        <span className="row-between">
          <h2 id={id} className="folder-path">
            <code>{group.folder ? tildePath(group.folder, home) : 'No folder'}</code>
            {group.branches.length > 0 && <span className="dim folder-branch"> on {group.branches.join(', ')}</span>}
          </h2>
          {group.folder && <span className={group.missing ? 'folder-state warn' : 'folder-state'}>{group.missing ? 'Folder does not exist yet' : 'Folder exists'}</span>}
        </span>
        {group.folder && (
          <span className={group.missing ? 'folder-hint warn' : 'folder-hint dim'}>
            {group.missing ? <HintLine hint={missingFolderHint(group.branches, clone, home)} /> : existingFolderHint(group.branches)}
          </span>
        )}
      </header>
      <ul className="plan">
        {group.entries.map((entry) => (
          <li key={entry.key} className="outcome" data-key={entry.key}>
            <OutcomeHead entry={entry} />
            {entry.message && <span className="plan-message">{entry.message}</span>}
            {entry.resume && <CommandLine command={entry.resume} />}
          </li>
        ))}
      </ul>
    </section>
  )
}

function OutcomeHead({ entry }: { entry: ResultEntry }) {
  return (
    <span className="outcome-head">
      <span className={`badge tone-${entry.badge.tone}`}>{entry.badge.label}</span>
      <span className="plan-title truncate">{entry.title}</span>
    </span>
  )
}
