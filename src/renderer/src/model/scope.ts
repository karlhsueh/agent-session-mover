import type { SessionKey, SessionSummary } from '../../../shared/sessions'
import { folderName } from './format'

declare const projectKeyBrand: unique symbol
/** A session's starting cwd, or NO_FOLDER when it recorded none. */
export type ProjectKey = string & { readonly [projectKeyBrand]: true }

/** Not a path any OS produces, so it cannot collide with a real cwd. */
export const NO_FOLDER = '\u0000no-folder' as ProjectKey

export function projectKeyOf(session: Pick<SessionSummary, 'cwd'>): ProjectKey {
  return (session.cwd ?? NO_FOLDER) as ProjectKey
}

/** What the middle list shows. Selection is keyed by session, so it outlives a scope change. */
export type Scope = { kind: 'all' } | { kind: 'project'; key: ProjectKey }

export const ALL: Scope = { kind: 'all' }

export function inScope(session: Pick<SessionSummary, 'cwd'>, scope: Scope): boolean {
  return scope.kind === 'all' || projectKeyOf(session) === scope.key
}

export function sameScope(a: Scope, b: Scope): boolean {
  return a.kind === 'all' ? b.kind === 'all' : b.kind === 'project' && a.key === b.key
}

export interface Project {
  key: ProjectKey
  name: string
  /** The parent folder's name, set only when another project has the same name. */
  parent: string | null
  path: string | null
  sessions: readonly SessionKey[]
  newest: string
  live: boolean
}

function parentName(path: string | null): string | null {
  if (!path) return null
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.at(-2) ?? null
}

/** One entry per starting folder, newest activity first. */
export function projectsOf(sessions: readonly SessionSummary[]): Project[] {
  const byKey = new Map<ProjectKey, Project>()
  for (const session of sessions) {
    const key = projectKeyOf(session)
    const path = key === NO_FOLDER ? null : key
    const project = byKey.get(key) ?? { key, name: folderName(path), parent: null, path, sessions: [], newest: '', live: false }
    byKey.set(key, {
      ...project,
      sessions: [...project.sessions, session.key],
      newest: session.lastActivity > project.newest ? session.lastActivity : project.newest,
      live: project.live || session.live,
    })
  }
  const projects = [...byKey.values()]
  const nameCount = new Map<string, number>()
  for (const project of projects) nameCount.set(project.name, (nameCount.get(project.name) ?? 0) + 1)
  return projects
    .map((project) => (nameCount.get(project.name)! > 1 ? { ...project, parent: parentName(project.path) } : project))
    .sort((a, b) => b.newest.localeCompare(a.newest) || a.name.localeCompare(b.name))
}

/** How many of `sessions` fall in each project. */
export function countByProject(sessions: readonly SessionSummary[]): Map<ProjectKey, number> {
  const counts = new Map<ProjectKey, number>()
  for (const session of sessions) counts.set(projectKeyOf(session), (counts.get(projectKeyOf(session)) ?? 0) + 1)
  return counts
}
