import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const MINUTE = 60_000
export const HOUR = 60
export const DAY = 24 * HOUR

export const encode = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-')

export interface Fixture {
  id: string
  title: string
  /** Folder under the fixture home. */
  project: string
  entrypoint: string
  ageMinutes: number
  live?: boolean
  subagents?: { type: string; description: string }[]
  /** Read-then-test rounds between the first prompt and the last reply. Defaults to 1. */
  rounds?: number
}

const ROUND_FILES = ['src/index.ts', 'src/queue.ts', 'src/worker.ts', 'test/queue.test.ts']

/** Writes one Claude Code session the way 2.1.x lays it out, ending `ageMinutes` ago. */
export async function writeClaudeSession(store: string, home: string, fixture: Fixture): Promise<void> {
  const cwd = join(home, fixture.project)
  const dir = join(store, 'projects', encode(cwd))
  await mkdir(dir, { recursive: true })
  const end = Date.now() - fixture.ageMinutes * MINUTE
  const turns: { type: 'user' | 'assistant'; content: unknown }[] = [{ type: 'user', content: fixture.title }]
  for (let round = 0; round < (fixture.rounds ?? 1); round++) {
    const file = ROUND_FILES[round % ROUND_FILES.length]!
    turns.push(
      { type: 'assistant', content: [{ type: 'text', text: `Reading ${file} first.` }, { type: 'tool_use', id: `toolu_r${round}`, name: 'Read', input: { file_path: join(cwd, file) } }] },
      { type: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_r${round}`, content: 'file contents' }] },
      { type: 'assistant', content: [{ type: 'tool_use', id: `toolu_b${round}`, name: 'Bash', input: { command: 'pnpm test', description: 'Run the tests' } }] },
      { type: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_b${round}`, content: 'all tests passed' }] },
    )
  }
  turns.push(
    { type: 'assistant', content: [{ type: 'text', text: 'The change is in and the tests pass.\n\nWant me to update the docs as well?' }] },
    { type: 'user', content: 'Looks good, continue.' },
    { type: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
  )
  let parentUuid: string | null = null
  const lines = turns.map((turn, index) => {
    const uuid = `${fixture.id.slice(0, 8)}-${String(index).padStart(4, '0')}-4000-8000-000000000000`
    const timestamp = new Date(end - (turns.length - 1 - index) * MINUTE).toISOString()
    const record = { parentUuid, isSidechain: false, userType: 'external', cwd, sessionId: fixture.id, version: '2.1.319', gitBranch: 'main', entrypoint: fixture.entrypoint, uuid, timestamp, type: turn.type, message: { role: turn.type, content: turn.content } }
    parentUuid = uuid
    return JSON.stringify(record)
  })
  lines.push(JSON.stringify({ type: 'ai-title', sessionId: fixture.id, aiTitle: fixture.title }))
  await writeFile(join(dir, `${fixture.id}.jsonl`), lines.join('\n') + '\n')
  for (const [index, agent] of (fixture.subagents ?? []).entries()) {
    const sub = join(dir, fixture.id, 'subagents')
    await mkdir(sub, { recursive: true })
    const agentId = `a${String(index).padStart(16, '0')}`
    const timestamp = new Date(end - (index + 5) * MINUTE).toISOString()
    const record = { type: 'user', isSidechain: true, agentId, cwd, sessionId: fixture.id, timestamp, message: { role: 'user', content: agent.description } }
    await writeFile(join(sub, `agent-${agentId}.jsonl`), JSON.stringify(record) + '\n')
    await writeFile(join(sub, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: agent.type, description: agent.description, isBuiltIn: true }))
  }
  if (fixture.live) {
    await mkdir(join(store, 'sessions'), { recursive: true })
    await writeFile(join(store, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: fixture.id, cwd, startedAt: Date.now(), kind: 'interactive', entrypoint: 'cli' }))
  }
}
