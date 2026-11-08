export const AGENT_IDS = ['claude-code', 'codex'] as const
export type AgentId = (typeof AGENT_IDS)[number]

declare const sessionKeyBrand: unique symbol
export type SessionKey = `${AgentId}:${string}` & { readonly [sessionKeyBrand]: true }

// Claude session ids are UUIDs and Codex thread ids are UUIDv7. The pattern is wider than
// both, but it never admits a path separator, a dot, or a leading dash.
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && (AGENT_IDS as readonly string[]).includes(value)
}

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value)
}

export function sessionKey(agent: AgentId, id: string): SessionKey {
  return `${agent}:${id}` as SessionKey
}

export function parseSessionKey(value: unknown): { key: SessionKey; agent: AgentId; id: string } | null {
  if (typeof value !== 'string') return null
  const colon = value.indexOf(':')
  const agent = value.slice(0, colon)
  const id = value.slice(colon + 1)
  if (colon < 0 || !isAgentId(agent) || !isSessionId(id)) return null
  return { key: sessionKey(agent, id), agent, id }
}

export type ClientKind = 'cli' | 'desktop' | 'ide' | 'sdk' | 'exec' | 'subagent' | 'unknown'

/** Shared by discovered sessions and sessions read from an archive. Times are ISO 8601. */
export interface SessionInfo {
  key: SessionKey
  agent: AgentId
  id: string
  /** Raw client marker: Claude `entrypoint`, Codex `originator`. Empty when the session has none. */
  client: ClientKind
  clientDetail: string
  title: string | null
  /** The working directory the session started in. It decides placement on import. */
  cwd: string | null
  /** Every distinct working directory in record order, `cwd` included. */
  cwds: string[]
  createdAt: string
  lastActivity: string
  cliVersion: string | null
  sizeBytes: number
  fileCount: number
}

export interface SessionSummary extends SessionInfo {
  /** A process that is still writing this session is running on this machine. */
  live: boolean
  archived: boolean
  /** The agent's own resume picker skips this session. The resume command still finds it. */
  hiddenFromPicker: boolean
  /** Shell line that resumes the session on this machine, `cd` included when the cwd is known. */
  resumeCommand: string
}

export interface SessionList {
  sessions: SessionSummary[]
  /** A store that could not be read. The other agents' sessions are still listed. */
  problems: { agent: AgentId; message: string }[]
}

declare const archiveTokenBrand: unique symbol
export type ArchiveToken = string & { readonly [archiveTokenBrand]: true }

export interface ArchiveSummary {
  fileName: string
  createdAt: string
  appVersion: string
  source: { platform: string; homeDir: string }
  sessions: SessionInfo[]
}

/** Rewrites the source path and everything under it to the target path. */
export interface PathMapping {
  source: string
  target: string
}

export type ConflictReason = 'diverged' | 'target-newer' | 'multiple-copies'
export type BlockedReason = 'live' | 'unmapped-cwd' | 'invalid-session' | 'unsafe-path'

export type ImportAction =
  | { kind: 'create' }
  | { kind: 'update'; backup: true }
  | { kind: 'skip-identical' }
  | { kind: 'conflict'; reason: ConflictReason; message: string }
  | { kind: 'blocked'; reason: BlockedReason; message: string }

export type ImportWarning =
  | { code: 'target-cwd-missing'; path: string }
  | { code: 'hidden-from-picker'; clientDetail: string }

export interface SessionImportPreview {
  key: SessionKey
  action: ImportAction
  /** Where the session's starting cwd maps on this machine, or null when unmapped. */
  targetCwd: string | null
  warnings: ImportWarning[]
}

export interface ImportPreview {
  sessions: SessionImportPreview[]
}

export type SessionImportOutcome =
  | { key: SessionKey; status: 'created' | 'updated' | 'skipped'; action: ImportAction; backupDir: string | null }
  | { key: SessionKey; status: 'refused'; action: ImportAction }
  | { key: SessionKey; status: 'failed'; action: ImportAction; error: string; rolledBack: boolean }

export interface ImportResult {
  runId: string
  outcomes: SessionImportOutcome[]
}

export interface ExportResult {
  filePath: string
  sessionCount: number
  fileCount: number
  bytes: number
  /** Sessions that were live during export. Their snapshot ends at the last complete line. */
  liveKeys: SessionKey[]
}

export type ProgressEvent =
  | { operation: 'export'; done: number; total: number }
  | { operation: 'open'; bytesRead: number; bytesTotal: number }
  | { operation: 'import'; done: number; total: number; current: SessionKey | null }
