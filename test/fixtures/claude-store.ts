import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { encodeProjectDir } from '../../src/main/providers/claude-code/encode'

/** Marker placed in every file export must never include. Tests grep archives for it. */
export const NEVER_EXPORT = 'NEVER-EXPORT-MARKER'

export async function makeTempDir(label: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), `agent-sessions-${label}-`)))
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

export interface FixtureSession {
  id: string
  cwd: string
  entrypoint?: string
  /** A later resume from another folder appends records with this cwd. */
  resumedFrom?: string
  customTitle?: string
  aiTitle?: string
  /** `true` writes one Explore agent with no description. */
  subagents?: boolean | FixtureSubagent[]
  toolResult?: boolean
  /** Ends the transcript with half a JSON line, as a live writer would leave it. */
  halfWrittenLastLine?: boolean
  /** Minutes after 2026-11-01T10:00:00Z for the first record. */
  startMinute?: number
  turns?: number
}

export interface FixtureSubagent {
  id: string
  /** Raw `agent-<id>.meta.json` content, or an object to serialize. Omitted means no meta file. */
  meta?: string | Record<string, unknown>
  prompt?: string
  /** Minutes after the base time for the agent's records. */
  minutes?: number[]
}

export interface BuiltSession {
  id: string
  dir: string
  transcriptPath: string
  lines: string[]
  lastTimestamp: string
  toolResultPath: string | null
}

const BASE_MS = Date.parse('2026-11-01T10:00:00.000Z')

function at(minute: number): string {
  return new Date(BASE_MS + minute * 60_000).toISOString()
}

/** Synthetic records shaped like Claude Code 2.1.x transcripts. No real conversation text. */
export function transcriptRecords(root: string, session: FixtureSession): { lines: string[]; lastTimestamp: string; toolResultPath: string | null } {
  const entrypoint = session.entrypoint ?? 'cli'
  const enc = encodeProjectDir(session.cwd)
  const start = session.startMinute ?? 0
  const lines: string[] = []
  let parent: string | null = null
  let minute = start
  const chain = (cwd: string, extra: Record<string, unknown>) => {
    const uuid = `${session.id.slice(0, 8)}-${String(lines.length).padStart(4, '0')}-4000-8000-000000000000`
    const record = { parentUuid: parent, isSidechain: false, userType: 'external', cwd, sessionId: session.id, version: '2.1.319', gitBranch: 'main', entrypoint, uuid, timestamp: at(minute), ...extra }
    parent = uuid
    minute += 1
    lines.push(JSON.stringify(record))
  }
  const toolResultPath = session.toolResult ? `${root}/projects/${enc}/${session.id}/tool-results/toolu_01.txt` : null

  chain(session.cwd, { type: 'user', message: { role: 'user', content: 'Add a unit test for the tokenizer' } })
  chain(session.cwd, { type: 'attachment', attachment: { type: 'environment', snapshot: { workingDirectory: session.cwd, isWorktree: false, platform: 'darwin', scratchpadDirectory: '/private/tmp/scratch' } } })
  for (let turn = 0; turn < (session.turns ?? 2); turn++) {
    chain(session.cwd, {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${turn}`, name: 'Read', input: { file_path: `${session.cwd}/src/tokenizer.ts` } }] },
    })
    chain(session.cwd, {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${turn}`, content: `Read ${session.cwd}/src/tokenizer.ts é ✓` }] },
      toolUseResult: turn === 0 && toolResultPath ? { persistedOutputPath: toolResultPath, filePath: `${session.cwd}/src/tokenizer.ts` } : { filePath: `${session.cwd}/src/tokenizer.ts` },
    })
  }
  lines.push(JSON.stringify({ type: 'ai-title', sessionId: session.id, aiTitle: session.aiTitle ?? 'Tokenizer test' }))
  if (session.customTitle) lines.push(JSON.stringify({ type: 'custom-title', sessionId: session.id, customTitle: session.customTitle }))
  if (session.resumedFrom) {
    chain(session.resumedFrom, { type: 'user', message: { role: 'user', content: 'Continue from the other checkout' } })
  }
  chain(session.cwd, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Done. See ${session.cwd}/test/tokenizer.test.ts` }] } })
  return { lines, lastTimestamp: at(minute - 1), toolResultPath }
}

export async function writeSession(root: string, session: FixtureSession): Promise<BuiltSession> {
  const dir = path.join(root, 'projects', encodeProjectDir(session.cwd))
  await mkdir(dir, { recursive: true })
  const { lines, lastTimestamp, toolResultPath } = transcriptRecords(root, session)
  const transcriptPath = path.join(dir, `${session.id}.jsonl`)
  const tail = session.halfWrittenLastLine ? '{"type":"assistant","message":{"role":"assist' : ''
  await writeFile(transcriptPath, lines.join('\n') + '\n' + tail)
  const agents: FixtureSubagent[] =
    session.subagents === true ? [{ id: 'a1b2c3', meta: { agentType: 'Explore', isBuiltIn: true, finished: true }, prompt: 'Search the repo', minutes: [3] }] : session.subagents || []
  for (const agent of agents) {
    const sub = path.join(dir, session.id, 'subagents')
    await mkdir(sub, { recursive: true })
    const records = (agent.minutes ?? [3]).map((minute, index) =>
      index === 0
        ? { type: 'user', cwd: session.cwd, sessionId: session.id, agentId: agent.id, isSidechain: true, timestamp: at(minute), message: { role: 'user', content: agent.prompt ?? 'Search the repo' } }
        : { type: 'assistant', cwd: session.cwd, sessionId: session.id, agentId: agent.id, isSidechain: true, timestamp: at(minute), message: { role: 'assistant', content: [{ type: 'text', text: 'Found it.' }] } },
    )
    await writeFile(path.join(sub, `agent-${agent.id}.jsonl`), records.map((record) => JSON.stringify(record)).join('\n') + '\n')
    if (agent.meta !== undefined) await writeFile(path.join(sub, `agent-${agent.id}.meta.json`), typeof agent.meta === 'string' ? agent.meta : JSON.stringify(agent.meta))
  }
  if (toolResultPath) {
    await mkdir(path.dirname(toolResultPath), { recursive: true })
    await writeFile(toolResultPath, 'line of tool output\n'.repeat(2000))
  }
  return { id: session.id, dir, transcriptPath, lines, lastTimestamp, toolResultPath }
}

/** Every artifact the spec says export must leave behind, each carrying the marker. */
export async function writeNeverExportFiles(root: string, aSession: { id: string; cwd: string }): Promise<void> {
  const enc = encodeProjectDir(aSession.cwd)
  const files: Record<string, string> = {
    'history.jsonl': JSON.stringify({ display: NEVER_EXPORT, sessionId: aSession.id }) + '\n',
    '.credentials.json': JSON.stringify({ token: NEVER_EXPORT }),
    [`file-history/${aSession.id}/0123456789abcdef@v1`]: NEVER_EXPORT,
    'shell-snapshots/snapshot-zsh-1-abc.sh': `export SECRET=${NEVER_EXPORT}`,
    [`session-env/${aSession.id}/env`]: NEVER_EXPORT,
    'paste-cache/abc.txt': NEVER_EXPORT,
    'backups/.claude.json.backup.1': NEVER_EXPORT,
    [`projects/${enc}/memory/MEMORY.md`]: NEVER_EXPORT,
    [`projects/${enc}/${aSession.id}.orphaned-1730000000-abc.jsonl`]: JSON.stringify({ type: 'user', note: NEVER_EXPORT }) + '\n',
    [`projects/${enc}/${aSession.id}.jsonl.superseded-1730000000`]: JSON.stringify({ type: 'user', note: NEVER_EXPORT }) + '\n',
    [`projects/${enc}/${aSession.id}/mcp-tasks/task.json`]: NEVER_EXPORT,
    [`projects/${enc}/${aSession.id}/tool-results/.DS_Store`]: NEVER_EXPORT,
    'sessions/4242.f00d.key': NEVER_EXPORT,
  }
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content)
  }
}

/** A registry entry the way a running Claude Code writes it. */
export async function writeLiveEntry(root: string, pid: number, sessionId: string): Promise<void> {
  await mkdir(path.join(root, 'sessions'), { recursive: true })
  await writeFile(path.join(root, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: '/x', startedAt: Date.now(), kind: 'interactive', entrypoint: 'cli' }))
}

export const DEAD_PID = 2 ** 30 - 7

export async function setMtime(file: string, ms: number): Promise<void> {
  await utimes(file, new Date(ms), new Date(ms))
}

/** Hash of every path, type, link target, and file content under `dir`. Mtimes are left out. */
export async function treeHash(dir: string): Promise<string> {
  const hash = createHash('sha256')
  async function walk(current: string, rel: string): Promise<void> {
    const info = await lstat(current).catch(() => null)
    if (!info) return
    if (info.isSymbolicLink()) hash.update(`L ${rel} ${await readlink(current)}\n`)
    else if (info.isDirectory()) {
      hash.update(`D ${rel}\n`)
      for (const name of (await readdir(current)).sort()) await walk(path.join(current, name), `${rel}/${name}`)
    } else hash.update(`F ${rel} ${createHash('sha256').update(await readFile(current)).digest('hex')}\n`)
  }
  await walk(dir, '')
  return hash.digest('hex')
}

export async function listTree(dir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(current: string, rel: string): Promise<void> {
    for (const name of (await readdir(current).catch(() => [])).sort()) {
      const child = path.join(current, name)
      const childRel = rel ? `${rel}/${name}` : name
      if ((await lstat(child)).isDirectory()) await walk(child, childRel)
      else out.push(childRel)
    }
  }
  await walk(dir, '')
  return out
}
