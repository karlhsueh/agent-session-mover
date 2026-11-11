import type { StoreRoot } from '../../../shared/ipc'
import type { SessionList as List } from '../../../shared/sessions'
import { AGENT_LABEL, MOD } from '../model/format'
import { Kbd } from './common'

export function Problems({ list }: { list: List }) {
  if (list.problems.length === 0) return null
  return (
    <div className="banner banner-warn" role="status">
      {list.problems.map((problem) => (
        <div key={problem.agent}>
          <strong>Could not read the {AGENT_LABEL[problem.agent]} store.</strong> <span className="banner-detail">{problem.message}</span>
        </div>
      ))}
    </div>
  )
}

export function EmptyStore({ list, storeRoots, onImport }: { list: List; storeRoots: StoreRoot[]; onImport: () => void }) {
  return (
    <div className="empty-store">
      <Problems list={list} />
      <div className="empty-card">
        <h1>No sessions on this machine</h1>
        <p className="dim">Agent Session Mover looked for Claude Code and Codex sessions in:</p>
        <ul className="roots">
          {storeRoots.map((root) => (
            <li key={root.agent}>
              <span>{AGENT_LABEL[root.agent]}</span>
              <code>{root.path}</code>
            </li>
          ))}
          {!storeRoots.some((root) => root.agent === 'codex') && (
            <li>
              <span>Codex</span>
              <span className="dim">Not supported in this build</span>
            </li>
          )}
        </ul>
        <p className="dim">
          Set <code>CLAUDE_CONFIG_DIR</code> or <code>CODEX_HOME</code> before launch if your stores live elsewhere. To bring sessions from another machine, open
          an archive.
        </p>
        <button type="button" className="button primary" onClick={onImport}>
          Import archive… <Kbd>{MOD}O</Kbd>
        </button>
      </div>
    </div>
  )
}
