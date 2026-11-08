import type { RolloutFacts, SessionMeta } from './facts'
import { sourceText } from './facts'
import type { Row, SqlValue } from './state-db'

export interface RowInput {
  id: string
  meta: SessionMeta
  facts: RolloutFacts
  /** Absolute path of the plain `.jsonl`, the form Codex records even for a compressed file. */
  rolloutPath: string
  cwd: string
  archived: boolean
  title: string | null
  name: string | null
  createdMs: number
  updatedMs: number
}

interface Column {
  /** `undefined` leaves the column to its default on insert and untouched on update. */
  value: (input: RowInput) => SqlValue | undefined
  /** Written on update too. Names, titles, and identity stay as the target has them. */
  update: boolean
}

const seconds = (ms: number) => Math.floor(ms / 1000)
const optional = (value: string | null) => value ?? undefined
const preview = (input: RowInput) => input.facts.firstUserMessage ?? input.title ?? input.id

/**
 * What import writes into `threads`, following how Codex fills a row from a rollout
 * (`state/src/extract.rs` in Codex 0.162.1). Only columns the target table reports are written. The
 * `*_ms` and recency columns are set explicitly, so the triggers that would derive them stay idle and
 * undo restores the exact earlier values.
 */
const COLUMNS: Record<string, Column> = {
  id: { value: (r) => r.id, update: false },
  rollout_path: { value: (r) => r.rolloutPath, update: true },
  created_at: { value: (r) => seconds(r.createdMs), update: false },
  created_at_ms: { value: (r) => r.createdMs, update: false },
  updated_at: { value: (r) => seconds(r.updatedMs), update: true },
  updated_at_ms: { value: (r) => r.updatedMs, update: true },
  recency_at: { value: (r) => seconds(r.updatedMs), update: true },
  recency_at_ms: { value: (r) => r.updatedMs, update: true },
  source: { value: (r) => sourceText(r.meta.source), update: false },
  thread_source: { value: (r) => optional(r.meta.threadSource), update: false },
  originator: { value: (r) => optional(r.meta.originator || null), update: false },
  model_provider: { value: (r) => r.meta.modelProvider ?? 'openai', update: false },
  model: { value: (r) => optional(r.facts.model), update: true },
  reasoning_effort: { value: (r) => optional(r.facts.effort), update: true },
  cwd: { value: (r) => r.cwd, update: true },
  title: { value: (r) => r.facts.firstUserMessage ?? r.title ?? '', update: false },
  name: { value: (r) => optional(r.name), update: false },
  // The visible lists skip rows with an empty preview.
  preview: { value: preview, update: false },
  first_user_message: { value: preview, update: false },
  sandbox_policy: { value: (r) => (r.facts.permissionProfile === null ? '' : JSON.stringify(r.facts.permissionProfile)), update: true },
  approval_mode: { value: (r) => r.facts.approvalPolicy ?? '', update: true },
  tokens_used: { value: (r) => r.facts.tokensUsed ?? 0, update: true },
  has_user_event: { value: (r) => (r.facts.hasUserEvent ? 1 : 0), update: true },
  archived: { value: (r) => (r.archived ? 1 : 0), update: true },
  archived_at: { value: (r) => (r.archived ? seconds(r.updatedMs) : null), update: true },
  git_sha: { value: (r) => optional(r.meta.git.sha), update: false },
  git_branch: { value: (r) => optional(r.meta.git.branch), update: false },
  git_origin_url: { value: (r) => optional(r.meta.git.originUrl), update: false },
  cli_version: { value: (r) => r.meta.cliVersion ?? '', update: true },
  agent_nickname: { value: (r) => optional(r.meta.agent.nickname), update: false },
  agent_role: { value: (r) => optional(r.meta.agent.role), update: false },
  agent_path: { value: (r) => optional(r.meta.agent.path), update: false },
  history_mode: { value: (r) => optional(r.meta.historyMode), update: false },
  creator_user_id: { value: (r) => optional(r.meta.creator.userId), update: false },
  creator_account_id: { value: (r) => optional(r.meta.creator.accountId), update: false },
}

/** The values to insert, or to update when the row exists, limited to columns the target table has. */
export function rowValues(input: RowInput, columns: ReadonlySet<string>, exists: boolean): Row {
  const row: Row = {}
  for (const [name, column] of Object.entries(COLUMNS)) {
    if (!columns.has(name) || (exists && !column.update)) continue
    const value = column.value(input)
    if (value !== undefined) row[name] = value
  }
  return row
}
