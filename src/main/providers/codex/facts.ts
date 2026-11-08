import type { ClientKind } from '../../../shared/sessions'
import type { JsonValue } from '../../core/provider'
import { GAP, type WindowLine } from '../../core/window'
import { cleanTitle } from '../text'

/** The fields of a rollout's first `session_meta` record that discovery and the `threads` row use. */
export interface SessionMeta {
  id: string
  cwd: string | null
  originator: string
  /** `"cli"`, `"exec"`, `"vscode"`, or an object such as `{ subagent: … }`. */
  source: JsonValue
  cliVersion: string | null
  timestamp: string | null
  modelProvider: string | null
  threadSource: string | null
  historyMode: string | null
  /** The rollout id of the prefix file this rollout continues from, by byte offset. */
  historyBase: string | null
  git: { sha: string | null; branch: string | null; originUrl: string | null }
  agent: { nickname: string | null; role: string | null; path: string | null }
  /** Set when a parent thread spawned this one, with the agent fields as `source` records them. */
  spawn: { parent: string; nickname: string | null; role: string | null; path: string | null } | null
  /** A spawned subagent's rollout starts with a copy of its parent's history. Records before this ordinal are that copy. */
  historyStart: number | null
  creator: { userId: string | null; accountId: string | null }
}

export interface RolloutFacts {
  meta: SessionMeta | null
  firstMs: number | null
  lastMs: number | null
  cwds: string[]
  latestCwd: string | null
  firstUserMessage: string | null
  hasUserEvent: boolean
  model: string | null
  effort: string | null
  approvalPolicy: string | null
  permissionProfile: JsonValue | null
  tokensUsed: number | null
  /** The first message the thread received after any inherited history: a parent agent's task, else a user prompt. */
  task: string | null
  /**
   * False when the rollout was too long to read whole and its middle was skipped. `cwds` then holds
   * only the folders in the parts read, and the model, settings, and token count come from the tail.
   */
  complete: boolean
}

/** What listing keeps from a rollout. Plain JSON, so the discovery cache can hold it. */
export type ListedFacts = Pick<RolloutFacts, 'meta' | 'firstMs' | 'lastMs' | 'cwds' | 'latestCwd' | 'firstUserMessage' | 'task' | 'complete'>

export function listedFacts({ meta, firstMs, lastMs, cwds, latestCwd, firstUserMessage, task, complete }: RolloutFacts): ListedFacts {
  return { meta, firstMs, lastMs, cwds, latestCwd, firstUserMessage, task, complete }
}

/** Reads complete lines only. A `GAP` marks a skipped middle. */
export async function readFacts(lines: AsyncIterable<WindowLine>): Promise<RolloutFacts> {
  const facts: RolloutFacts = {
    meta: null,
    firstMs: null,
    lastMs: null,
    cwds: [],
    latestCwd: null,
    firstUserMessage: null,
    hasUserEvent: false,
    model: null,
    effort: null,
    approvalPolicy: null,
    permissionProfile: null,
    tokensUsed: null,
    task: null,
    complete: true,
  }
  // A plain user `response_item` is the fallback title for old rollouts that predate `UserMessage` events.
  let fallbackPrompt: string | null = null
  for await (const line of lines) {
    if (line === GAP) {
      facts.complete = false
      continue
    }
    const record = parseObject(line)
    if (!record) continue
    const ms = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN
    if (!Number.isNaN(ms)) {
      facts.firstMs = facts.firstMs === null ? ms : Math.min(facts.firstMs, ms)
      facts.lastMs = facts.lastMs === null ? ms : Math.max(facts.lastMs, ms)
    }
    const payload = isObject(record.payload) ? record.payload : {}
    if (record.type === 'session_meta' && !facts.meta) {
      facts.meta = sessionMeta(payload)
      seeCwd(facts, facts.meta?.cwd ?? null)
    }
    if (facts.task === null && !(typeof record.ordinal === 'number' && record.ordinal < (facts.meta?.historyStart ?? 0))) {
      facts.task = taskText(record.type, payload)
    }
    if (record.type === 'turn_context') {
      seeCwd(facts, str(payload.cwd))
      facts.model = str(payload.model) ?? facts.model
      facts.effort = str(payload.effort) ?? facts.effort
      facts.approvalPolicy = str(payload.approval_policy) ?? facts.approvalPolicy
      facts.permissionProfile = (payload.permission_profile ?? payload.sandbox_policy ?? facts.permissionProfile) as JsonValue | null
    }
    if (record.type === 'event_msg') absorbEvent(facts, payload)
    if (record.type === 'response_item' && fallbackPrompt === null && payload.type === 'message' && payload.role === 'user') {
      fallbackPrompt = promptText(payload.content, 'input_text')
    }
  }
  facts.firstUserMessage ??= fallbackPrompt
  return facts
}

function absorbEvent(facts: RolloutFacts, payload: Record<string, unknown>): void {
  const prompt = userPrompt(payload)
  if (prompt !== undefined) {
    facts.hasUserEvent = true
    facts.firstUserMessage ??= prompt
  }
  if (payload.type === 'token_count' && isObject(payload.info) && isObject(payload.info.total_token_usage)) {
    const total = payload.info.total_token_usage.total_tokens
    if (typeof total === 'number' && Number.isSafeInteger(total)) facts.tokensUsed = total
  }
  if (payload.type === 'thread_settings_applied' && isObject(payload.thread_settings)) seeCwd(facts, str(payload.thread_settings.cwd))
}

/** The prompt of a user message event, null when it has no usable text, and undefined for any other event. */
function userPrompt(payload: Record<string, unknown>): string | null | undefined {
  if (payload.type === 'item_completed' && isObject(payload.item) && payload.item.type === 'UserMessage') return promptText(payload.item.content, 'text')
  if (payload.type !== 'user_message') return undefined
  const message = str(payload.message)
  return message && !message.trimStart().startsWith('<') ? cleanTitle(message) : null
}

function taskText(type: unknown, payload: Record<string, unknown>): string | null {
  if (type === 'response_item' && payload.type === 'agent_message') return promptText(payload.content, 'input_text')
  return type === 'event_msg' ? (userPrompt(payload) ?? null) : null
}

function seeCwd(facts: RolloutFacts, cwd: string | null): void {
  if (!cwd) return
  facts.latestCwd = cwd
  if (!facts.cwds.includes(cwd)) facts.cwds.push(cwd)
}

function promptText(content: unknown, textType: string): string | null {
  if (!Array.isArray(content)) return null
  const first = content.find((part) => isObject(part) && part.type === textType && typeof part.text === 'string')
  const text = first ? (first.text as string) : null
  // Injected context (environment, AGENTS.md, skills) is wrapped in tags. It is not the user's prompt.
  if (!text || text.trimStart().startsWith('<')) return null
  return cleanTitle(text)
}

export function sessionMeta(payload: Record<string, unknown>): SessionMeta | null {
  const id = str(payload.id)
  if (!id) return null
  const git = isObject(payload.git) ? payload.git : {}
  const base = isObject(payload.history_base) ? str(payload.history_base.thread_id) : null
  const start = payload.subagent_history_start_ordinal
  return {
    id: id.toLowerCase(),
    cwd: str(payload.cwd),
    originator: str(payload.originator) ?? '',
    source: (payload.source ?? null) as JsonValue,
    cliVersion: str(payload.cli_version),
    timestamp: str(payload.timestamp),
    modelProvider: str(payload.model_provider),
    threadSource: str(payload.thread_source),
    historyMode: str(payload.history_mode),
    historyBase: base?.toLowerCase() ?? null,
    git: { sha: str(git.commit_hash), branch: str(git.branch), originUrl: str(git.repository_url) },
    agent: { nickname: str(payload.agent_nickname), role: str(payload.agent_role), path: str(payload.agent_path) },
    spawn: spawnOf(payload.source),
    historyStart: typeof start === 'number' && Number.isSafeInteger(start) ? start : null,
    creator: { userId: str(payload.creator_user_id), accountId: str(payload.creator_account_id) },
  }
}

/** Only a `thread_spawn` subagent has a parent. Review and compact subagents have none. */
function spawnOf(source: unknown): SessionMeta['spawn'] {
  const spawn = isObject(source) && isObject(source.subagent) && isObject(source.subagent.thread_spawn) ? source.subagent.thread_spawn : null
  const parent = spawn && str(spawn.parent_thread_id)
  if (!spawn || !parent) return null
  return { parent: parent.toLowerCase(), nickname: str(spawn.agent_nickname), role: str(spawn.agent_role) ?? str(spawn.agent_type), path: str(spawn.agent_path) }
}

export function metaOfLine(bytes: Buffer | null): SessionMeta | null {
  const record = bytes && parseObject(bytes)
  if (!record || record.type !== 'session_meta' || !isObject(record.payload)) return null
  return sessionMeta(record.payload)
}

/** Codex stores `source` in the `threads` row as the enum's serde string: a bare name, or JSON for a variant with data. */
export function sourceText(source: JsonValue): string {
  return typeof source === 'string' ? source : JSON.stringify(source)
}

const CLIENT_BY_ORIGINATOR: Record<string, ClientKind> = {
  'Codex Desktop': 'desktop',
  codex_work_desktop: 'desktop',
  codex_exec: 'exec',
  'codex-tui': 'cli',
  codex_cli_rs: 'cli',
}
const CLIENT_BY_SOURCE: Record<string, ClientKind> = { cli: 'cli', exec: 'exec', vscode: 'ide' }

/** The desktop app reports source `vscode`, so the originator decides before the source does. */
export function clientOf(meta: SessionMeta | null): ClientKind {
  if (!meta) return 'unknown'
  if (isObject(meta.source) && 'subagent' in meta.source) return 'subagent'
  return CLIENT_BY_ORIGINATOR[meta.originator] ?? (typeof meta.source === 'string' ? CLIENT_BY_SOURCE[meta.source] : undefined) ?? 'unknown'
}

const PICKER_SOURCES = new Set(['cli', 'vscode'])

/** The resume picker lists only interactive sources. `codex resume <id>` still finds the rest. */
export function hiddenFromPicker(meta: SessionMeta): boolean {
  return !(typeof meta.source === 'string' && PICKER_SOURCES.has(meta.source))
}

export function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

export function parseObject(bytes: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
