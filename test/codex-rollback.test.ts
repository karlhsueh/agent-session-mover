import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recoverJournals, SimulatedCrash } from '../src/main/core/executor'
import { type CoreContext, exportSessions } from '../src/main/core/export'
import { defaultExists, openArchive, runImport, suggestMappings } from '../src/main/core/import'
import type { Provider, ProviderEffect } from '../src/main/core/provider'
import { codexProvider } from '../src/main/providers/codex'
import { providers } from '../src/main/providers/registry'
import { requestsFor, sessionKey } from '../src/shared/sessions'
import { listTree, removeTempDir } from './fixtures/claude-store'
import { createStateDb, spawnEdges, threadRows } from './fixtures/codex-db'
import { appendRecord, buildCodexStore, type CodexStore, CX } from './fixtures/codex-store'
import { type Machine, makeMachine } from './fixtures/machine'

const key = (id: string) => sessionKey('codex', id)
let a: Machine
let b: Machine
let src: CodexStore

beforeEach(async () => {
  a = await makeMachine('codex-source')
  b = await makeMachine('codex-target')
  src = await buildCodexStore(a.codexRoot, path.join(a.home, 'proj'))
  await mkdir(b.codexRoot, { recursive: true })
  createStateDb(targetDb(), [{ id: CX.decoy, rollout_path: '/x/rollout.jsonl', cwd: '/x', title: 'Decoy', preview: 'Decoy' }])
})
afterEach(async () => {
  await removeTempDir(a.dir)
  await removeTempDir(b.dir)
})

const targetDb = () => path.join(b.codexRoot, 'state_5.sqlite')
const journalDir = () => path.join(b.appData, 'journal')

/** Every file under the target home except the database, whose bytes SQLite may rewrite without changing a row. */
async function filesHash(): Promise<string> {
  const hash = createHash('sha256')
  for (const rel of await listTree(b.home)) {
    if (path.basename(rel).startsWith('state_5.sqlite')) continue
    hash.update(`${rel} ${createHash('sha256').update(await readFile(path.join(b.home, rel))).digest('hex')}\n`)
  }
  return hash.digest('hex')
}

async function snapshotTarget() {
  return { files: await filesHash(), rows: threadRows(targetDb()), edges: spawnEdges(targetDb()) }
}

/** The real provider, with a fault right before or right after one kind of effect. */
function faulty(kind: string, when: 'before' | 'after', mode: 'error' | 'crash'): CoreContext {
  const fail = () => {
    throw mode === 'crash' ? new SimulatedCrash(`crash ${when} ${kind}`) : new Error(`injected failure ${when} ${kind}`)
  }
  const codex: Provider = {
    ...codexProvider,
    async applyEffect(root: string, effect: ProviderEffect) {
      if (effect.kind === kind && when === 'before') fail()
      await codexProvider.applyEffect(root, effect)
      if (effect.kind === kind && when === 'after') fail()
    },
  }
  return { ...b.context, providers: { ...providers, codex } }
}

async function importOne(id: string, context: CoreContext = b.context, name = 'a.agentsessions', fault?: { afterWrites: number; mode: 'error' }) {
  const file = path.join(a.dir, name)
  await exportSessions(a.context, [key(id)], file)
  const opened = await openArchive(b.context, file)
  const mappings = suggestMappings(opened.manifest, { homeDir: b.home, sep: path.sep, exists: defaultExists })
  return runImport(context, opened, mappings, requestsFor([key(id)]), { fault })
}

const importPlain = (context?: CoreContext, name?: string) => importOne(CX.plain, context, name)

describe('Codex rollback', () => {
  it('leaves files and rows as they were when a file write fails', async () => {
    const before = await snapshotTarget()
    const file = path.join(a.dir, 'a.agentsessions')
    await exportSessions(a.context, [key(CX.plain)], file)
    const opened = await openArchive(b.context, file)
    const mappings = suggestMappings(opened.manifest, { homeDir: b.home, sep: path.sep, exists: defaultExists })
    const [outcome] = (await runImport(b.context, opened, mappings, requestsFor([key(CX.plain)]), { fault: { afterWrites: 1, mode: 'error' } })).outcomes
    expect(outcome).toMatchObject({ status: 'failed', rolledBack: true })
    expect(await snapshotTarget()).toEqual(before)
  })

  it('deletes the row it inserted and the index line it appended when the last step fails', async () => {
    const before = await snapshotTarget()
    const [outcome] = (await importPlain(faulty('index-line', 'after', 'error'))).outcomes
    expect(outcome).toMatchObject({ status: 'failed', rolledBack: true })
    expect(await snapshotTarget()).toEqual(before)
    expect(await readdir(journalDir())).toEqual([])
  })

  it('restores the earlier row values and file when a failed update had already changed the row', async () => {
    await importPlain()
    await appendRecord(src.rollouts[CX.plain].absPath, 500, { type: 'token_count', info: { total_token_usage: { total_tokens: 9 } } })
    const before = await snapshotTarget()
    const [outcome] = (await importPlain(faulty('thread-row', 'after', 'error'), 'b.agentsessions')).outcomes
    expect(outcome).toMatchObject({ status: 'failed', rolledBack: true, action: { kind: 'update' } })
    expect(await snapshotTarget()).toEqual(before)
  })
})

describe('Codex rollback of a session with subagents', () => {
  it('leaves files, rows, and edges as they were when a write fails partway through the subagents', async () => {
    const before = await snapshotTarget()
    const [outcome] = (await importOne(CX.parent, b.context, 'p.agentsessions', { afterWrites: 2, mode: 'error' })).outcomes
    expect(outcome).toMatchObject({ status: 'failed', rolledBack: true })
    expect(await snapshotTarget()).toEqual(before)
  })

  it('removes the rows and edges it wrote when an edge write fails', async () => {
    const before = await snapshotTarget()
    const [outcome] = (await importOne(CX.parent, faulty('spawn-edge', 'after', 'error'))).outcomes
    expect(outcome).toMatchObject({ status: 'failed', rolledBack: true })
    expect(await snapshotTarget()).toEqual(before)
  })

  it('recovers from a crash after the first edge, and a second recovery is a no-op', async () => {
    const before = await snapshotTarget()
    await expect(importOne(CX.parent, faulty('spawn-edge', 'after', 'crash'))).rejects.toThrow(SimulatedCrash)
    expect(spawnEdges(targetDb()).length).toBe(1)
    expect(await recoverJournals(journalDir(), providers)).toMatchObject([{ ok: true, errors: [] }])
    expect(await snapshotTarget()).toEqual(before)
    expect(await recoverJournals(journalDir(), providers)).toEqual([])
  })
})

describe('Codex crash recovery', () => {
  it('rolls back a row written before a crash, and a second recovery is a no-op', async () => {
    const before = await snapshotTarget()
    await expect(importPlain(faulty('thread-row', 'after', 'crash'))).rejects.toThrow(SimulatedCrash)
    expect(threadRows(targetDb()).map((row) => row.id)).toContain(CX.plain)

    expect(await recoverJournals(journalDir(), providers)).toMatchObject([{ ok: true, errors: [] }])
    expect(await snapshotTarget()).toEqual(before)
    expect(await recoverJournals(journalDir(), providers)).toEqual([])
    expect(await snapshotTarget()).toEqual(before)
  })

  it('leaves every row alone when the crash came after journaling the row but before writing it', async () => {
    await importPlain()
    await appendRecord(src.rollouts[CX.plain].absPath, 500, { type: 'user_message', message: 'more' })
    const before = await snapshotTarget()
    await expect(importPlain(faulty('thread-row', 'before', 'crash'), 'b.agentsessions')).rejects.toThrow(SimulatedCrash)
    expect(await recoverJournals(journalDir(), providers)).toMatchObject([{ ok: true }])
    expect(await snapshotTarget()).toEqual(before)
  })
})

describe('Codex effects read back from a journal', () => {
  it('refuses an effect that names a file other than the thread database', async () => {
    const effect = { kind: 'thread-row', db: path.join(b.home, 'notes.sqlite'), id: CX.plain, row: { id: CX.plain }, prior: null }
    await expect(codexProvider.undoEffect(b.codexRoot, effect)).rejects.toThrow('Not a Codex import effect')
    await expect(codexProvider.undoEffect(b.codexRoot, { kind: 'index-line', line: 'a\nb' })).rejects.toThrow('Not a Codex import effect')
  })

  it('treats undo of a row that was never written as a no-op', async () => {
    const before = threadRows(targetDb())
    await codexProvider.undoEffect(b.codexRoot, { kind: 'thread-row', db: targetDb(), id: CX.decoy, row: { id: CX.decoy, title: 'Not what is there' }, prior: null })
    await codexProvider.undoEffect(b.codexRoot, { kind: 'thread-row', db: path.join(b.dir, 'absent', 'state_5.sqlite'), id: CX.decoy, row: { id: CX.decoy }, prior: null })
    expect(threadRows(targetDb())).toEqual(before)
  })
})
