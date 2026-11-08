import { appendFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDiscovery } from '../src/main/core/discovery'
import { createSessionService } from '../src/main/service'
import type { ScanProgress } from '../src/shared/sessions'
import { removeTempDir, writeSession } from './fixtures/claude-store'
import { buildCodexStore } from './fixtures/codex-store'
import { type Machine, makeMachine } from './fixtures/machine'

const IDS = ['9a000000-0000-4000-8000-000000000001', '9a000000-0000-4000-8000-000000000002', '9a000000-0000-4000-8000-000000000003']

let machine: Machine
let transcripts: string[]
beforeEach(async () => {
  machine = await makeMachine('discovery-progress')
  const cwd = path.join(machine.home, 'code', 'proj')
  transcripts = []
  for (const [index, id] of IDS.entries()) transcripts.push((await writeSession(machine.root, { id, cwd, subagents: index === 0 })).transcriptPath)
})
afterEach(async () => removeTempDir(machine.dir))

async function listWithProgress(discovery = createDiscovery(machine.context)): Promise<ScanProgress[]> {
  const events: ScanProgress[] = []
  const list = await discovery.list('claude-code', (event) => events.push(event))
  expect(list.problems).toEqual([])
  return events
}

describe('listing progress', () => {
  it('counts every file a first pass reads, and ends with all of them done', async () => {
    const subagent = path.join(path.dirname(transcripts[0]!), IDS[0]!, 'subagents', 'agent-a1b2c3.jsonl')
    const sizes = await Promise.all([...transcripts, subagent].map(async (file) => (await stat(file)).size))
    const events = await listWithProgress()
    expect(events[0]).toMatchObject({ operation: 'scan', agent: 'claude-code', filesDone: 0, filesTotal: 4, bytesDone: 0 })
    expect(events.at(-1)).toMatchObject({ filesDone: 4, filesTotal: 4, bytesDone: sizes.reduce((a, b) => a + b), bytesTotal: sizes.reduce((a, b) => a + b) })
  })

  it('reports nothing when no file changed, and only the changed file after one did', async () => {
    const discovery = createDiscovery(machine.context)
    await listWithProgress(discovery)
    expect(await listWithProgress(discovery)).toEqual([])
    await appendFile(transcripts[1]!, JSON.stringify({ type: 'custom-title', sessionId: IDS[1], customTitle: 'Later' }) + '\n')
    const events = await listWithProgress(discovery)
    expect(events.at(-1)).toMatchObject({ filesDone: 1, filesTotal: 1, current: `projects/${path.basename(path.dirname(transcripts[1]!))}/${IDS[1]}.jsonl` })
  })

  it('lists one agent at a time through the service, refusing an unknown agent', async () => {
    await buildCodexStore(machine.codexRoot, path.join(machine.home, 'code', 'proj'))
    const service = createSessionService(machine.context)
    const events: ScanProgress[] = []
    const codex = await service.listSessions('codex', (event) => event.operation === 'scan' && events.push(event))
    expect(codex.ok && codex.value.sessions.every((session) => session.agent === 'codex')).toBe(true)
    expect(new Set(events.map((event) => event.agent))).toEqual(new Set(['codex']))
    const bad = await service.listSessions('../claude', () => undefined)
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await service.dispose()
  })
})
