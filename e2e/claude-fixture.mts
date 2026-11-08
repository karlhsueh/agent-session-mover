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
}

/** Writes one Claude Code session the way 2.1.x lays it out, ending `ageMinutes` ago. */
export async function writeClaudeSession(store: string, home: string, fixture: Fixture): Promise<void> {
  const cwd = join(home, fixture.project)
  const dir = join(store, 'projects', encode(cwd))
  await mkdir(dir, { recursive: true })
  const end = Date.now() - fixture.ageMinutes * MINUTE
  let parentUuid: string | null = null
  const lines = [0, 1, 2, 3].map((turn) => {
    const uuid = `${fixture.id.slice(0, 8)}-000${turn}-4000-8000-000000000000`
    const message = turn % 2 === 0 ? { role: 'user', content: turn === 0 ? fixture.title : 'Looks good, continue.' } : { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }
    const record = { parentUuid, isSidechain: false, userType: 'external', cwd, sessionId: fixture.id, version: '2.1.319', gitBranch: 'main', entrypoint: fixture.entrypoint, uuid, timestamp: new Date(end - (3 - turn) * MINUTE).toISOString(), type: turn % 2 === 0 ? 'user' : 'assistant', message }
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
