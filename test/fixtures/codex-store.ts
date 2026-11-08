import { appendFile, mkdir, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { NEVER_EXPORT } from './claude-store'
import { createStateDb, type FixtureRow } from './codex-db'

/** Synthetic UUIDv7-shaped ids. */
export const CX = {
  plain: '019a0000-0000-7000-8000-000000000001',
  archived: '019a0000-0000-7000-8000-000000000002',
  compressed: '019a0000-0000-7000-8000-000000000003',
  reverted: '019a0000-0000-7000-8000-000000000004',
  revertedRollout: '019a0000-0000-7000-8000-0000000000f4',
  parent: '019a0000-0000-7000-8000-000000000005',
  child: '019a0000-0000-7000-8000-000000000006',
  /** Spawned by `parent`, and spawned `grandchild` in turn. */
  subagent: '019a0000-0000-7000-8000-000000000007',
  subagent2: '019a0000-0000-7000-8000-00000000000a',
  grandchild: '019a0000-0000-7000-8000-00000000000b',
  /** A subagent whose parent thread is not in the store. */
  orphan: '019a0000-0000-7000-8000-00000000000c',
  missingParent: '019a0000-0000-7000-8000-0000000000ee',
  live: '019a0000-0000-7000-8000-000000000008',
  hosted: '019a0000-0000-7000-8000-000000000009',
  decoy: '019a0000-0000-7000-8000-00000000000d',
} as const

export interface FixtureRollout {
  id: string
  /** Set for the extra file a revert writes. Defaults to the thread id. */
  rolloutId?: string
  cwd: string
  /** Minutes after 2026-11-01T10:00:00Z. Also names the file, as if local time were UTC. */
  startMinute?: number
  originator?: string
  source?: unknown
  archived?: boolean
  compressed?: boolean
  historyBase?: { rolloutId: string; endOrdinal: number; endByteOffset: number }
  /** Null leaves out the user message, as a subagent thread does. */
  prompt?: string | null
  turns?: number
  /** Records an image Codex saved for this thread, by absolute path into the source store. */
  savedImage?: string
  /** Makes this a spawned subagent. Codex writes the agent fields both into `source` and onto `session_meta`. */
  spawn?: { parent: string; depth: number; nickname?: string; role?: string; path?: string }
  /** A forked subagent's rollout repeats its parent's records before its own. */
  inherit?: string[]
  /** The message the parent agent sent the subagent. */
  task?: string
}

export interface BuiltRollout {
  rel: string
  absPath: string
  /** The plain bytes, whatever form the file is stored in. */
  plain: Buffer
  lines: string[]
  lastTimestamp: string
}

const BASE_MS = Date.parse('2026-11-01T10:00:00.000Z')
const iso = (minute: number) => new Date(BASE_MS + minute * 60_000).toISOString()
const stamp = (minute: number) => iso(minute).slice(0, 19).replace(/:/g, '-')

/** Records shaped like Codex 0.162 rollouts. No real conversation text. */
export function rolloutLines(r: FixtureRollout): string[] {
  const start = r.startMinute ?? 0
  const lines: string[] = []
  let minute = start
  const push = (type: string, payload: Record<string, unknown>) => {
    lines.push(JSON.stringify({ timestamp: iso(minute), ordinal: lines.length, type, payload }))
    minute += 1
  }
  const spawn = r.spawn && { agent_nickname: r.spawn.nickname ?? null, agent_role: r.spawn.role ?? null, agent_path: r.spawn.path ?? null }
  const historyStart = r.inherit ? r.inherit.length + 1 : null
  push('session_meta', {
    id: r.id,
    session_id: r.id,
    timestamp: iso(start),
    cwd: r.cwd,
    originator: r.originator ?? 'codex-tui',
    cli_version: '0.162.1',
    source: r.spawn ? { subagent: { thread_spawn: { parent_thread_id: r.spawn.parent, depth: r.spawn.depth, ...spawn } } } : (r.source ?? 'cli'),
    ...(spawn ? { ...spawn, parent_thread_id: r.spawn!.parent, forked_from_id: r.spawn!.parent } : {}),
    ...(historyStart === null ? {} : { subagent_history_start_ordinal: historyStart }),
    thread_source: 'user',
    model_provider: 'openai',
    history_mode: 'paginated',
    base_instructions: { text: 'synthetic instructions' },
    creator_user_id: 'user-synthetic',
    git: { commit_hash: 'a1b2c3d', branch: 'main', repository_url: 'https://example.invalid/repo.git' },
    ...(r.historyBase ? { history_base: { thread_id: r.historyBase.rolloutId, end_ordinal_exclusive: r.historyBase.endOrdinal, end_byte_offset: r.historyBase.endByteOffset } } : {}),
  })
  for (const line of r.inherit ?? []) lines.push(JSON.stringify({ ...JSON.parse(line), ordinal: lines.length }))
  if (r.task) push('response_item', { type: 'agent_message', author: '/root', recipient: r.spawn?.path ?? '/root/agent', content: [{ type: 'input_text', text: r.task }] })
  const permission = { type: 'workspace-write', file_system: { entries: [{ path: { path: r.cwd } }] } }
  push('turn_context', { cwd: r.cwd, model: 'gpt-5.5-codex', effort: 'medium', approval_policy: 'on-request', permission_profile: permission, turn_id: 't0' })
  push('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<environment_context><cwd>${r.cwd}</cwd></environment_context>` }] })
  if (r.prompt !== null) {
    push('event_msg', { type: 'item_completed', item: { type: 'UserMessage', id: 'u0', content: [{ type: 'text', text: r.prompt ?? 'Add a unit test for the tokenizer', text_elements: [] }] } })
    push('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: r.prompt ?? 'Add a unit test for the tokenizer' }] })
  }
  for (let turn = 0; turn < (r.turns ?? 2); turn++) {
    push('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: `c${turn}`, command: ['cat', `${r.cwd}/src/tokenizer.ts`], cwd: r.cwd, exit_code: 0 } })
    push('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Read ${r.cwd}/src/tokenizer.ts é ✓` }] })
    push('event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: 1000 + turn } } })
  }
  if (r.savedImage) push('event_msg', { type: 'item_completed', item: { type: 'Extension', id: 'img0', savedPath: r.savedImage, status: 'completed' } })
  return lines
}

export function rolloutRel(r: FixtureRollout): string {
  const name = `rollout-${stamp(r.startMinute ?? 0)}-${r.id}${r.rolloutId ? `_${r.rolloutId}` : ''}.jsonl${r.compressed ? '.zst' : ''}`
  if (r.archived) return `archived_sessions/${name}`
  const [y, m, d] = iso(r.startMinute ?? 0).slice(0, 10).split('-')
  return `sessions/${y}/${m}/${d}/${name}`
}

export async function writeRollout(root: string, r: FixtureRollout): Promise<BuiltRollout> {
  const lines = rolloutLines(r)
  const plain = Buffer.from(lines.join('\n') + '\n')
  const rel = rolloutRel(r)
  const absPath = path.join(root, ...rel.split('/'))
  await mkdir(path.dirname(absPath), { recursive: true })
  await writeFile(absPath, r.compressed ? zstdCompressSync(plain) : plain)
  const lastTimestamp = JSON.parse(lines.at(-1)!).timestamp as string
  await utimes(absPath, new Date(lastTimestamp), new Date(lastTimestamp))
  return { rel, absPath, plain, lines, lastTimestamp }
}

/** Appends one record, as Codex does on the next turn. */
export async function appendRecord(file: string, minute: number, payload: Record<string, unknown>): Promise<void> {
  await appendFile(file, JSON.stringify({ timestamp: iso(minute), ordinal: 999, type: 'event_msg', payload }) + '\n')
}

export async function writeIndexLine(root: string, id: string, name: string): Promise<string> {
  const line = JSON.stringify({ id, thread_name: name, updated_at: iso(30) })
  await appendFile(path.join(root, 'session_index.jsonl'), line + '\n')
  return line
}

export async function writeLock(root: string, id: string): Promise<void> {
  await mkdir(path.join(root, 'thread-writer-locks'), { recursive: true })
  await writeFile(path.join(root, 'thread-writer-locks', `${id}.lock`), '')
}

/** Every artifact the spec says export must leave behind, each carrying the marker. */
export async function writeNeverExportFiles(root: string, id: string): Promise<void> {
  const files: Record<string, string> = {
    'auth.json': JSON.stringify({ tokens: { access_token: NEVER_EXPORT } }),
    'config.toml': `[mcp_servers.x.env]\nTOKEN = "${NEVER_EXPORT}"\n`,
    '.codex-global-state.json': JSON.stringify({ 'electron-mac-push-deregistration-token': NEVER_EXPORT }),
    'history.jsonl': JSON.stringify({ session_id: id, ts: 1, text: NEVER_EXPORT }) + '\n',
    'logs_2.sqlite': NEVER_EXPORT,
    'thread_history_1.sqlite': NEVER_EXPORT,
    installation_id: NEVER_EXPORT,
    [`shell_snapshots/${id}.1730000000000.sh`]: `export SECRET=${NEVER_EXPORT}`,
    'sqlite/codex.db': NEVER_EXPORT,
    'attachments/0000/pasted.txt': NEVER_EXPORT,
    'thread-writer-locks/.coordination.lock': '',
  }
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content)
  }
}

export interface CodexStore {
  rollouts: Record<string, BuiltRollout>
  revertedOriginal: BuiltRollout
  imagePath: string
  subagentImage: string
  indexLine: string
  db: string
}

/** One store with every shape the provider must handle. `cwd` is the folder the sessions ran in. */
export async function buildCodexStore(root: string, cwd: string, options: { db?: boolean } = {}): Promise<CodexStore> {
  const imagePath = path.join(root, 'generated_images', CX.plain, 'call_1.png')
  const subagentImage = path.join(root, 'generated_images', CX.subagent2, 'call_2.png')
  const rollouts: Record<string, BuiltRollout> = {}
  rollouts[CX.plain] = await writeRollout(root, { id: CX.plain, cwd, savedImage: imagePath })
  rollouts[CX.archived] = await writeRollout(root, { id: CX.archived, cwd, startMinute: 20, archived: true, originator: 'Codex Desktop', source: 'vscode', prompt: 'Archive me' })
  rollouts[CX.compressed] = await writeRollout(root, { id: CX.compressed, cwd, startMinute: 40, compressed: true, originator: 'codex_exec', source: 'exec', prompt: 'Run the exec job' })

  const revertedOriginal = await writeRollout(root, { id: CX.reverted, cwd, startMinute: 60, prompt: 'Before the revert' })
  const revertKeep = revertedOriginal.lines.slice(0, 4)
  rollouts[CX.reverted] = await writeRollout(root, {
    id: CX.reverted,
    rolloutId: CX.revertedRollout,
    cwd,
    startMinute: 80,
    prompt: 'After the revert',
    historyBase: { rolloutId: CX.reverted, endOrdinal: revertKeep.length, endByteOffset: Buffer.byteLength(revertKeep.join('\n') + '\n') },
  })

  rollouts[CX.parent] = await writeRollout(root, { id: CX.parent, cwd, startMinute: 100, prompt: 'Parent thread' })
  const forkKeep = rollouts[CX.parent].lines.slice(0, 5)
  rollouts[CX.child] = await writeRollout(root, {
    id: CX.child,
    cwd,
    startMinute: 120,
    prompt: 'Forked child',
    historyBase: { rolloutId: CX.parent, endOrdinal: forkKeep.length, endByteOffset: Buffer.byteLength(forkKeep.join('\n') + '\n') },
  })
  const subagent = (id: string, startMinute: number, spawn: NonNullable<FixtureRollout['spawn']>, task: string, extra: Partial<FixtureRollout> = {}) =>
    writeRollout(root, { id, cwd, startMinute, prompt: null, spawn, task, inherit: rollouts[spawn.parent]?.lines, ...extra })
  rollouts[CX.subagent] = await subagent(CX.subagent, 140, { parent: CX.parent, depth: 1, nickname: 'Ada', path: '/root/review' }, 'Review the tokenizer change')
  rollouts[CX.grandchild] = await subagent(CX.grandchild, 150, { parent: CX.subagent, depth: 2, path: '/root/review/deep_check' }, 'Check the edge cases')
  rollouts[CX.subagent2] = await subagent(CX.subagent2, 170, { parent: CX.parent, depth: 1, role: 'explorer', path: '/root/map' }, 'Map the parser module', { savedImage: subagentImage })
  rollouts[CX.orphan] = await subagent(CX.orphan, 180, { parent: CX.missingParent, depth: 1, nickname: 'Orphaned', path: '/root/lost' }, 'Lost task')
  rollouts[CX.live] = await writeRollout(root, { id: CX.live, cwd, startMinute: 160, prompt: 'Still running' })
  await writeLock(root, CX.live)

  await mkdir(path.dirname(imagePath), { recursive: true })
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
  await mkdir(path.dirname(subagentImage), { recursive: true })
  await writeFile(subagentImage, Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]))
  const indexLine = await writeIndexLine(root, CX.plain, 'Renamed tokenizer work')
  await writeIndexLine(root, CX.parent, 'Parent by name')

  const db = path.join(root, 'state_5.sqlite')
  if (options.db !== false) {
    const row = (id: string, extra: Partial<FixtureRow> = {}): FixtureRow => ({ id, rollout_path: path.join(root, rollouts[id].rel.replace(/\.zst$/, '')), cwd, ...extra })
    createStateDb(db, [
      row(CX.plain, { title: 'Add a unit test for the tokenizer' }),
      row(CX.archived, { title: 'Database title for archived', archived: 1, source: 'vscode' }),
      { id: CX.hosted, rollout_path: path.join(root, 'sessions/2026/11/01/missing.jsonl'), cwd, title: NEVER_EXPORT, preview: NEVER_EXPORT },
    ])
  }
  return { rollouts, revertedOriginal, imagePath, subagentImage, indexLine, db }
}
