import { type AgentId, type ClientKind, isAgentId, isSessionId } from '../../shared/sessions'
import { parseStorePath, type StorePath } from './paths'

export const MANIFEST_FORMAT = 'agent-sessions-archive'
export const MANIFEST_VERSION = 1

/** Every file role, keyed by the agent that may use it. The validator rejects a role under the wrong agent. */
export const ROLES_BY_AGENT = {
  'claude-code': ['transcript', 'subagent', 'tool-result'],
  codex: ['rollout', 'subagent-rollout', 'linked-rollout', 'generated-image', 'index-entry'],
} as const satisfies Record<AgentId, readonly string[]>

export type FileRole = (typeof ROLES_BY_AGENT)[AgentId][number]

declare const sha256Brand: unique symbol
export type Sha256 = string & { readonly [sha256Brand]: true }

export function isSha256(value: unknown): value is Sha256 {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

export interface ManifestFile {
  role: FileRole
  path: StorePath
  sha256: Sha256
  size: number
  mtimeMs: number
}

export interface ManifestSession {
  agent: AgentId
  id: string
  title: string | null
  client: ClientKind
  clientDetail: string
  cwd: string | null
  cwds: string[]
  createdAt: string
  lastActivity: string
  cliVersion: string | null
  /** Absent in archives written before it existed. */
  gitBranch: string | null
  files: ManifestFile[]
}

export interface ManifestSource {
  platform: string
  homeDir: string
  sep: '/' | '\\'
  /** Absolute store root per agent on the source machine. Import uses it to remap paths that point into the store. */
  storeRoots: Partial<Record<AgentId, string>>
  /** The source computer's name. Null in archives written before it existed. */
  computerName: string | null
  /** The git repos the sessions ran in, each with one remote address. Empty in archives written before it existed. */
  repos: ManifestRepo[]
}

/** A repo's working tree on the source computer and its remote, without credentials. */
export interface ManifestRepo {
  folder: string
  remote: string
}

export interface Manifest {
  format: typeof MANIFEST_FORMAT
  version: typeof MANIFEST_VERSION
  createdAt: string
  appVersion: string
  source: ManifestSource
  sessions: ManifestSession[]
}

export class ManifestError extends Error {}

const CLIENT_KINDS: readonly ClientKind[] = ['cli', 'desktop', 'ide', 'sdk', 'exec', 'subagent', 'unknown']
const MAX_SESSIONS = 100_000
const MAX_FILES_PER_SESSION = 100_000
const MAX_TEXT = 4096
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

export function parseManifest(input: unknown): Manifest {
  const root = record(input, 'manifest')
  if (root.format !== MANIFEST_FORMAT) fail('manifest.format', 'is not an Agent Session Mover archive')
  if (root.version !== MANIFEST_VERSION) fail('manifest.version', `must be ${MANIFEST_VERSION}`)
  const sourceRecord = record(root.source, 'manifest.source')
  const sep = sourceRecord.sep
  if (sep !== '/' && sep !== '\\') fail('manifest.source.sep', 'must be / or \\')
  const storeRootsRecord = record(sourceRecord.storeRoots, 'manifest.source.storeRoots')
  const storeRoots: Partial<Record<AgentId, string>> = {}
  for (const [agent, value] of Object.entries(storeRootsRecord)) {
    if (!isAgentId(agent)) fail(`manifest.source.storeRoots.${agent}`, 'is not a known agent')
    storeRoots[agent] = text(value, `manifest.source.storeRoots.${agent}`)
  }
  const source: ManifestSource = {
    platform: text(sourceRecord.platform, 'manifest.source.platform'),
    homeDir: text(sourceRecord.homeDir, 'manifest.source.homeDir'),
    sep,
    storeRoots,
    computerName: nullable(sourceRecord.computerName ?? null, (v) => computerName(v, 'manifest.source.computerName')),
    repos: repos(sourceRecord.repos ?? [], 'manifest.source.repos'),
  }

  const sessionsInput = root.sessions
  if (!Array.isArray(sessionsInput) || sessionsInput.length > MAX_SESSIONS) fail('manifest.sessions', 'must be a list')
  const sessions = sessionsInput.map((value, index) => parseSession(value, `manifest.sessions[${index}]`))

  const seenSessions = new Set<string>()
  const sizeBySha = new Map<string, number>()
  for (const session of sessions) {
    const key = `${session.agent}:${session.id}`
    if (seenSessions.has(key)) fail('manifest.sessions', `lists ${key} twice`)
    seenSessions.add(key)
    const seenPaths = new Set<string>()
    for (const file of session.files) {
      if (seenPaths.has(file.path)) fail(`${key} files`, `list ${file.path} twice`)
      seenPaths.add(file.path)
      const known = sizeBySha.get(file.sha256)
      if (known !== undefined && known !== file.size) fail(`${key} ${file.path}`, 'has a size that disagrees with its hash')
      sizeBySha.set(file.sha256, file.size)
    }
  }

  return {
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    createdAt: time(root.createdAt, 'manifest.createdAt'),
    appVersion: text(root.appVersion, 'manifest.appVersion'),
    source,
    sessions,
  }
}

function parseSession(input: unknown, where: string): ManifestSession {
  const value = record(input, where)
  const agent = value.agent
  if (!isAgentId(agent)) fail(`${where}.agent`, 'is not a known agent')
  if (!isSessionId(value.id)) fail(`${where}.id`, 'is not a valid session id')
  const client = value.client
  if (typeof client !== 'string' || !CLIENT_KINDS.includes(client as ClientKind)) fail(`${where}.client`, 'is not a known client')
  const cwds = value.cwds
  if (!Array.isArray(cwds) || cwds.length > MAX_FILES_PER_SESSION) fail(`${where}.cwds`, 'must be a list')
  const files = value.files
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES_PER_SESSION) {
    fail(`${where}.files`, 'must be a non-empty list')
  }
  return {
    agent,
    id: value.id,
    title: nullable(value.title, (v) => text(v, `${where}.title`)),
    client: client as ClientKind,
    clientDetail: text(value.clientDetail, `${where}.clientDetail`, true),
    cwd: nullable(value.cwd, (v) => text(v, `${where}.cwd`)),
    cwds: cwds.map((cwd, index) => text(cwd, `${where}.cwds[${index}]`)),
    createdAt: time(value.createdAt, `${where}.createdAt`),
    lastActivity: time(value.lastActivity, `${where}.lastActivity`),
    cliVersion: nullable(value.cliVersion, (v) => text(v, `${where}.cliVersion`)),
    gitBranch: nullable(value.gitBranch ?? null, (v) => text(v, `${where}.gitBranch`)),
    files: files.map((file, index) => parseFile(file, agent, `${where}.files[${index}]`)),
  }
}

function parseFile(input: unknown, agent: AgentId, where: string): ManifestFile {
  const value = record(input, where)
  const roles: readonly string[] = ROLES_BY_AGENT[agent]
  if (typeof value.role !== 'string' || !roles.includes(value.role)) fail(`${where}.role`, `is not a ${agent} file role`)
  const path = parseStorePath(value.path)
  if (!path) fail(`${where}.path`, 'is not a safe store-relative path')
  if (!isSha256(value.sha256)) fail(`${where}.sha256`, 'is not a lowercase sha256 hex digest')
  if (!Number.isSafeInteger(value.size) || (value.size as number) < 0) fail(`${where}.size`, 'must be a non-negative integer')
  if (typeof value.mtimeMs !== 'number' || !Number.isFinite(value.mtimeMs) || value.mtimeMs < 0) {
    fail(`${where}.mtimeMs`, 'must be a non-negative number')
  }
  return { role: value.role as FileRole, path, sha256: value.sha256, size: value.size as number, mtimeMs: value.mtimeMs }
}

function computerName(value: unknown, where: string): string {
  if (typeof value !== 'string' || sanitizeComputerName(value) !== value) fail(where, 'must be a short plain name')
  return value
}

function repos(value: unknown, where: string): ManifestRepo[] {
  if (!Array.isArray(value) || value.length > MAX_REPOS) fail(where, 'must be a list')
  const seen = new Set<string>()
  return value.map((entry, index) => {
    const repo = record(entry, `${where}[${index}]`)
    const folder = text(repo.folder, `${where}[${index}].folder`)
    if (seen.has(folder)) fail(where, 'lists a folder twice')
    seen.add(folder)
    if (!isSafeRemote(repo.remote)) fail(`${where}[${index}].remote`, 'is not a git remote address without credentials')
    return { folder, remote: repo.remote }
  })
}

const MAX_REPOS = 10_000
const MAX_COMPUTER_NAME = 128
const MAX_REMOTE = 2048
// Control characters, and the bidi controls that could make a name read as something else.
const UNSAFE_NAME = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g

/** A name trimmed, with control characters removed and the length capped. Null when nothing is left. */
export function sanitizeComputerName(raw: string): string | null {
  const name = [...raw.replace(UNSAFE_NAME, ' ').replace(/\s+/g, ' ').trim()].slice(0, MAX_COMPUTER_NAME).join('').trim()
  return name === '' ? null : name
}

const REMOTE_CHARS = /^[A-Za-z0-9._~:/@%+=-]+$/
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]*(:\d{1,5})?$/
const URL_FORM = /^(https?|ssh|git|git\+ssh|ssh\+git):\/\/([^/]+)(\/.*)?$/
const SCP_FORM = /^(?:([A-Za-z0-9][A-Za-z0-9._-]*)@)?([A-Za-z0-9][A-Za-z0-9.-]*):(?!\/\/)[A-Za-z0-9._~%+=@-][A-Za-z0-9._~/%+=@-]*$/

/**
 * A network git address a user could paste into `git clone`: a URL with no password, and no user at
 * all for http(s), or the `user@host:path` form. Shell and option characters never pass.
 */
export function isSafeRemote(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_REMOTE || !REMOTE_CHARS.test(value)) return false
  const url = value.match(URL_FORM)
  if (url) {
    const authority = url[2]!
    const at = authority.lastIndexOf('@')
    const user = at >= 0 ? authority.slice(0, at) : null
    if (user !== null && (url[1]!.startsWith('http') || user === '' || user.includes(':'))) return false
    return HOST.test(authority.slice(at + 1))
  }
  const scp = value.match(SCP_FORM)
  return scp !== null && (scp[1] !== undefined || scp[2]!.includes('.'))
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(where, 'must be an object')
  return value as Record<string, unknown>
}

function text(value: unknown, where: string, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > MAX_TEXT || value.includes('\0') || (!allowEmpty && value === '')) {
    fail(where, 'must be a short string')
  }
  return value
}

function time(value: unknown, where: string): string {
  if (typeof value !== 'string' || !ISO_TIME.test(value) || Number.isNaN(Date.parse(value))) fail(where, 'must be an ISO time')
  return value
}

function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value === null ? null : parse(value)
}

function fail(where: string, problem: string): never {
  throw new ManifestError(`${where} ${problem}`)
}
