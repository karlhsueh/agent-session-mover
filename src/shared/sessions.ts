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
  /** The git branch at the session's last record that names one. Null outside a repo or when unrecorded. */
  gitBranch: string | null
  sizeBytes: number
  fileCount: number
}

/** A helper agent the session started. It is exported and imported with its parent, never on its own. */
export interface SubagentSummary {
  id: string
  /** The task or prompt the parent gave it, when the agent records one. */
  title: string | null
  /** The agent type or nickname, such as `Explore` or `Ada`. */
  role: string | null
  lastActivity: string | null
}

export interface SessionSummary extends SessionInfo {
  /**
   * False when the main transcript was too long to read whole, so `cwds` lists only the folders in
   * the parts read. An export reads every line, so an archive's `cwds` is always complete.
   */
  cwdsComplete: boolean
  /** A process that is still writing this session is running on this machine. */
  live: boolean
  archived: boolean
  /** The agent's own resume picker skips this session. The resume command still finds it. */
  hiddenFromPicker: boolean
  /** Newest first. Empty when the session started none. */
  subagents: SubagentSummary[]
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
  source: { platform: string; homeDir: string; sep: '/' | '\\' }
  sessions: SessionInfo[]
}

/** Rewrites the source path and everything under it to the target path. */
export interface PathMapping {
  source: string
  target: string
}

/** True when `value` is `root` or a path inside it. `/a/app-two` is not inside `/a/app`. */
export function isAtOrUnder(value: string, root: string, sep: string): boolean {
  return value === root || value.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** `diverged`: the two copies differ. `target-newer`: the copy here continues past the archive's. */
export type ConflictReason = 'diverged' | 'target-newer'
export type BlockedReason = 'live' | 'unmapped-cwd' | 'invalid-session' | 'unsafe-path' | 'multiple-copies' | 'newer-here'

export type ImportAction =
  | { kind: 'create' }
  | { kind: 'update'; backup: true }
  | { kind: 'skip-identical' }
  /**
   * This machine already has a different copy. Import keeps it unless the user chooses `replace`,
   * which moves it to the backup folder first, the way an update does.
   */
  | { kind: 'conflict'; reason: ConflictReason; message: string; hereChangedAt: string | null }
  /** Import cannot place the session, whatever the user chooses. */
  | { kind: 'blocked'; reason: BlockedReason; message: string }

/** What import does with a session whose plan is a conflict when it runs. */
export type ConflictChoice = 'skip' | 'replace'

/** One session to import. `onConflict` matters only if import, planning again, finds a conflict. */
export interface ImportRequest {
  key: SessionKey
  onConflict: ConflictChoice
}

export function requestsFor(keys: readonly SessionKey[], onConflict: ConflictChoice = 'skip'): ImportRequest[] {
  return keys.map((key) => ({ key, onConflict }))
}

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
  | { key: SessionKey; status: 'created' | 'updated' | 'replaced' | 'skipped'; action: ImportAction; backupDir: string | null; resumeCommand: string }
  | { key: SessionKey; status: 'refused'; action: ImportAction }
  | { key: SessionKey; status: 'failed'; action: ImportAction; error: string; rolledBack: boolean }

export interface ImportResult {
  runId: string
  outcomes: SessionImportOutcome[]
  /** This run's backup folder, or null when no session replaced a file. */
  backupDir: string | null
}

export interface ExportResult {
  filePath: string
  sessionCount: number
  fileCount: number
  bytes: number
  /** Sessions that were live during export. Their snapshot ends at the last complete line. */
  liveKeys: SessionKey[]
}

/**
 * A listing pass reading one agent's store. It counts only the files that pass must read: files whose
 * facts are kept from an earlier pass are not counted, so a refresh with nothing new sends no events.
 */
export interface ScanProgress {
  operation: 'scan'
  agent: AgentId
  filesDone: number
  filesTotal: number
  bytesDone: number
  bytesTotal: number
  /** Store-relative path of the file being read. */
  current: string | null
}

export type ProgressEvent =
  | ScanProgress
  /** Sent as each session starts. `current` counts from 1. */
  | { operation: 'export'; phase: 'read'; current: number; total: number }
  /** Uncompressed bytes fed to the archive. Writing takes most of an export. */
  | { operation: 'export'; phase: 'write'; bytesDone: number; bytesTotal: number }
  | { operation: 'open'; bytesRead: number; bytesTotal: number }
  /** `bytesTotal` is twice the selected sessions' size: half fills while the app plans each session, half while it writes. */
  | { operation: 'import'; done: number; total: number; current: SessionKey | null; bytesDone: number; bytesTotal: number }

/** One entry in the Conversation tab. Text is plain, whitespace-collapsed, and capped. Never HTML. */
export type PreviewMessage =
  | { kind: 'user'; text: string; at: string | null }
  | { kind: 'assistant'; text: string; at: string | null }
  /** One line, such as `Read src/main/index.ts` or `Ran pnpm test`. `name` is the agent's tool name. */
  | { kind: 'tool'; name: string; summary: string; at: string | null }

export interface PreviewCounts {
  /** User and assistant messages. */
  messages: number
  toolCalls: number
}

export type SessionPreview =
  | {
      kind: 'ok'
      /** The conversation's first entry, usually the prompt that started it. */
      first: PreviewMessage
      /** The newest entries, oldest first. Never repeats `first`. */
      recent: PreviewMessage[]
      /** Entries between `first` and `recent`. */
      omitted: PreviewCounts
      counts: PreviewCounts
      /** False when the transcript was too long to read whole. `counts` and `omitted` are then lower bounds. */
      complete: boolean
    }
  | { kind: 'unavailable'; reason: string }
