import { useEffect, type RefObject } from 'react'
import { plural, tildePath } from '../model/format'
import { ALL, sameScope, type Project, type ProjectKey, type Scope } from '../model/scope'

interface Props {
  projects: readonly Project[]
  scope: Scope
  total: number
  /** Matches per project while a search or filter runs, null otherwise. */
  matches: ReadonlyMap<ProjectKey, number> | null
  matchTotal: number
  selected: ReadonlyMap<ProjectKey, number>
  selectedTotal: number
  home: string
  onScope: (scope: Scope) => void
  sidebarRef: RefObject<HTMLDivElement | null>
}

export function scopeId(scope: Scope): string {
  return scope.kind === 'all' ? 'scope-all' : `scope-${encodeURIComponent(scope.key)}`
}

export function Sidebar({ projects, scope, total, matches, matchTotal, selected, selectedTotal, home, onScope, sidebarRef }: Props) {
  useEffect(() => {
    document.getElementById(scopeId(scope))?.scrollIntoView({ block: 'nearest' })
  }, [scope])

  return (
    <nav className="sidebar" aria-label="Project scopes">
      <div ref={sidebarRef} role="listbox" aria-label="Projects" aria-activedescendant={scopeId(scope)} tabIndex={0} className="scopes">
        <Entry
          scope={ALL}
          active={scope.kind === 'all'}
          name="All sessions"
          title={plural(total, 'session')}
          count={matches ? matchTotal : total}
          selected={selectedTotal}
          onScope={onScope}
        />
        <h3 className="scopes-label" aria-hidden="true">
          Projects
        </h3>
        {projects.map((project) => {
          const own: Scope = { kind: 'project', key: project.key }
          return (
            <Entry
              key={project.key}
              scope={own}
              active={sameScope(scope, own)}
              name={project.name}
              parent={project.parent}
              title={project.path ? tildePath(project.path, home) : 'Sessions that recorded no folder'}
              count={matches ? (matches.get(project.key) ?? 0) : project.sessions.length}
              selected={selected.get(project.key) ?? 0}
              live={project.live}
              onScope={onScope}
            />
          )
        })}
      </div>
    </nav>
  )
}

function Entry({
  scope,
  active,
  name,
  parent = null,
  title,
  count,
  selected,
  live = false,
  onScope,
}: {
  scope: Scope
  active: boolean
  name: string
  parent?: string | null
  title: string
  count: number
  selected: number
  live?: boolean
  onScope: (scope: Scope) => void
}) {
  const label = [name, parent && `in ${parent}`, plural(count, 'session'), selected > 0 && `${selected} selected`, live && 'live'].filter(Boolean).join(', ')
  return (
    <div
      id={scopeId(scope)}
      role="option"
      aria-selected={active}
      aria-label={label}
      title={title}
      className={`scope${active ? ' active' : ''}${count === 0 ? ' no-match' : ''}`}
      onClick={() => onScope(scope)}
    >
      <span className="scope-name truncate">
        {name}
        {parent && <span className="scope-parent"> {parent}</span>}
      </span>
      {live && <span className="scope-live" aria-hidden="true" />}
      <span className="scope-tally" aria-hidden="true" title={selected > 0 ? `${selected} selected of ${count}` : undefined}>
        {selected > 0 && <span className="scope-pill">{selected}</span>}
        <span className="scope-count">{count}</span>
      </span>
    </div>
  )
}
