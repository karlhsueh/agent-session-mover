import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeCodeProvider } from '../src/main/providers/claude-code'
import { removeTempDir, writeSession } from './fixtures/claude-store'
import { type Machine, makeMachine } from './fixtures/machine'

const ID = '2a000000-0000-4000-8000-000000000001'
const at = (minute: number) => new Date(Date.parse('2026-11-01T10:00:00.000Z') + minute * 60_000).toISOString()

let machine: Machine
beforeEach(async () => {
  machine = await makeMachine('subagents')
})
afterEach(async () => removeTempDir(machine.dir))

async function discoverOne() {
  const [session] = await claudeCodeProvider.discover(machine.root, machine.context.env)
  return session
}

describe('Claude Code subagent summaries', () => {
  it('lists each agent newest first with its description, type, and last record time', async () => {
    await writeSession(machine.root, {
      id: ID,
      cwd: '/w',
      subagents: [
        { id: 'aold', meta: { agentType: 'Explore', description: 'Find the retry config' }, minutes: [2, 4] },
        { id: 'anew', meta: { agentType: 'general-purpose', description: '  Write   the\nmigration  ' }, minutes: [5, 9, 7] },
      ],
    })
    expect((await discoverOne()).subagents).toEqual([
      { id: 'anew', title: 'Write the migration', role: 'general-purpose', lastActivity: at(9) },
      { id: 'aold', title: 'Find the retry config', role: 'Explore', lastActivity: at(4) },
    ])
  })

  it('falls back to the first prompt when the agent has no description or no meta file', async () => {
    await writeSession(machine.root, {
      id: ID,
      cwd: '/w',
      subagents: [
        { id: 'anometa', prompt: 'Read the changelog', minutes: [6] },
        { id: 'anodesc', meta: { agentType: 'Plan' }, prompt: 'Sketch the schema', minutes: [3] },
      ],
    })
    expect((await discoverOne()).subagents).toEqual([
      { id: 'anometa', title: 'Read the changelog', role: null, lastActivity: at(6) },
      { id: 'anodesc', title: 'Sketch the schema', role: 'Plan', lastActivity: at(3) },
    ])
  })

  it('tolerates malformed meta files and transcript lines, and skips meta files with no transcript', async () => {
    const built = await writeSession(machine.root, { id: ID, cwd: '/w', subagents: [{ id: 'abroken', meta: '{"agentType": "Expl', prompt: 'Grep for TODOs', minutes: [8] }] })
    const sub = path.join(built.dir, ID, 'subagents')
    await writeFile(path.join(sub, 'agent-abroken.jsonl'), 'not json\n' + JSON.stringify({ type: 'user', timestamp: at(8), message: { role: 'user', content: 'Grep for TODOs' } }) + '\n{"half')
    await writeFile(path.join(sub, 'agent-aorphan.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Lost agent' }))
    await mkdir(path.join(sub, 'agent-adir.jsonl'))
    expect((await discoverOne()).subagents).toEqual([{ id: 'abroken', title: 'Grep for TODOs', role: null, lastActivity: at(8) }])
  })

  it('is empty for a session that started no agents', async () => {
    await writeSession(machine.root, { id: ID, cwd: '/w' })
    expect((await discoverOne()).subagents).toEqual([])
  })
})
