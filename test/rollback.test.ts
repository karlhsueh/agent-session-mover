import { appendFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recoverJournals, SimulatedCrash } from '../src/main/core/executor'
import { exportSessions } from '../src/main/core/export'
import { defaultExists, openArchive, type OpenedArchive, runImport, suggestMappings } from '../src/main/core/import'
import type { PathMapping } from '../src/shared/sessions'
import { sessionKey } from '../src/shared/sessions'
import { removeTempDir, treeHash, writeSession } from './fixtures/claude-store'
import { type Machine, makeMachine } from './fixtures/machine'
import { providers } from '../src/main/providers/registry'

const S1 = '3a000000-0000-4000-8000-000000000001'
const S2 = '3b000000-0000-4000-8000-000000000002'
const key = (id: string) => sessionKey('claude-code', id)

let a: Machine
let b: Machine
let transcriptPath: string

beforeEach(async () => {
  a = await makeMachine('source')
  b = await makeMachine('target')
  const cwd = path.join(a.home, 'proj')
  transcriptPath = (await writeSession(a.root, { id: S1, cwd, subagents: true, toolResult: true })).transcriptPath
  await writeSession(a.root, { id: S2, cwd })
})
afterEach(async () => {
  await removeTempDir(a.dir)
  await removeTempDir(b.dir)
})

async function archiveOf(name: string, ids: string[]): Promise<{ opened: OpenedArchive; mappings: PathMapping[] }> {
  const file = path.join(a.dir, name)
  await exportSessions(a.context, ids.map(key), file)
  const opened = await openArchive(b.context, file)
  return { opened, mappings: suggestMappings(opened.manifest, { homeDir: b.home, sep: '/', exists: defaultExists }) }
}

const journals = async () => (await readdir(path.join(b.appData, 'journal')).catch(() => [])).filter((n) => n.endsWith('.jsonl'))

describe('rollback', () => {
  it('undoes a failed create so the store is byte-identical to before', async () => {
    await writeSession(b.root, { id: '3c000000-0000-4000-8000-000000000003', cwd: '/already/here' })
    const before = await treeHash(b.home)
    const { opened, mappings } = await archiveOf('a.agentsessions', [S1])
    const [outcome] = (await runImport(b.context, opened, mappings, [key(S1)], { fault: { afterWrites: 3, mode: 'error' } })).outcomes
    expect(outcome).toMatchObject({ status: 'failed', rolledBack: true })
    expect(await treeHash(b.home)).toBe(before)
    expect(await journals()).toEqual([])
  })

  it('restores the original file when a failed update already moved it to the backup folder', async () => {
    const first = await archiveOf('a.agentsessions', [S1])
    await runImport(b.context, first.opened, first.mappings, [key(S1)])
    await appendFile(transcriptPath, JSON.stringify({ type: 'system', sessionId: S1, timestamp: '2026-11-05T00:00:00.000Z' }) + '\n')
    const before = await treeHash(b.home)

    const second = await archiveOf('b.agentsessions', [S1])
    const [outcome] = (await runImport(b.context, second.opened, second.mappings, [key(S1)], { fault: { afterWrites: 1, mode: 'error' } })).outcomes
    expect(outcome).toMatchObject({ status: 'failed', rolledBack: true, action: { kind: 'update' } })
    expect(await treeHash(b.home)).toBe(before)
  })

  it('keeps a session that committed when a later session in the same run fails', async () => {
    const { opened, mappings } = await archiveOf('a.agentsessions', [S1, S2])
    // The fault counts writes within one session: S2 has one file and commits, S1 has four and fails on the second.
    const result = await runImport(b.context, opened, mappings, [key(S2), key(S1)], { fault: { afterWrites: 2, mode: 'error' } })
    expect(result.outcomes.map((o) => o.status)).toEqual(['created', 'failed'])
    const files = (await readdir(path.join(b.root, 'projects'), { recursive: true })).map(String)
    expect(files.some((f) => f.endsWith(`${S2}.jsonl`))).toBe(true)
    expect(files.some((f) => f.includes(S1))).toBe(false)
  })
})

describe('crash recovery', () => {
  it('rolls back a journal left by a crash, and a second recovery is a no-op', async () => {
    const before = await treeHash(b.home)
    const { opened, mappings } = await archiveOf('a.agentsessions', [S1])
    await expect(runImport(b.context, opened, mappings, [key(S1)], { fault: { afterWrites: 2, mode: 'crash' } })).rejects.toThrow(SimulatedCrash)
    expect(await treeHash(b.home)).not.toBe(before)
    expect(await journals()).toHaveLength(1)

    const results = await recoverJournals(path.join(b.appData, 'journal'), providers)
    expect(results).toMatchObject([{ ok: true, errors: [] }])
    expect(await treeHash(b.home)).toBe(before)
    expect(await journals()).toEqual([])
    expect(await recoverJournals(path.join(b.appData, 'journal'), providers)).toEqual([])
    expect(await treeHash(b.home)).toBe(before)
  })

  it('restores a backed-up original after a crash mid-update', async () => {
    const first = await archiveOf('a.agentsessions', [S1])
    await runImport(b.context, first.opened, first.mappings, [key(S1)])
    await appendFile(transcriptPath, JSON.stringify({ type: 'system', sessionId: S1, timestamp: '2026-11-05T00:00:00.000Z' }) + '\n')
    const before = await treeHash(b.home)
    const second = await archiveOf('b.agentsessions', [S1])
    await expect(runImport(b.context, second.opened, second.mappings, [key(S1)], { fault: { afterWrites: 1, mode: 'crash' } })).rejects.toThrow(SimulatedCrash)
    await recoverJournals(path.join(b.appData, 'journal'), providers)
    expect(await treeHash(b.home)).toBe(before)
  })

  it('ignores a torn final journal line and still rolls back what was recorded', async () => {
    const before = await treeHash(b.home)
    const { opened, mappings } = await archiveOf('a.agentsessions', [S1])
    await expect(runImport(b.context, opened, mappings, [key(S1)], { fault: { afterWrites: 1, mode: 'crash' } })).rejects.toThrow(SimulatedCrash)
    const [journal] = await journals()
    await appendFile(path.join(b.appData, 'journal', journal), '{"kind":"publ')
    await recoverJournals(path.join(b.appData, 'journal'), providers)
    expect(await treeHash(b.home)).toBe(before)
  })

  it('never deletes a file at a published path that this run did not write', async () => {
    const { opened, mappings } = await archiveOf('a.agentsessions', [S1])
    await expect(runImport(b.context, opened, mappings, [key(S1)], { fault: { afterWrites: 1, mode: 'crash' } })).rejects.toThrow(SimulatedCrash)
    const projectDir = path.join(b.root, 'projects', (await readdir(path.join(b.root, 'projects')))[0])
    const transcript = path.join(projectDir, `${S1}.jsonl`)
    await writeFile(transcript, 'someone else wrote this\n')
    const results = await recoverJournals(path.join(b.appData, 'journal'), providers)
    expect(results[0].ok).toBe(true)
    expect(await readdir(projectDir)).toContain(`${S1}.jsonl`)
  })
})
