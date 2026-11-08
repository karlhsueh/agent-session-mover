import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listSessions } from '../src/main/core/discovery'
import { exportSessions } from '../src/main/core/export'
import { defaultExists, openArchive, runImport, suggestMappings } from '../src/main/core/import'
import { type SessionKey, type SessionSummary, sessionKey } from '../src/shared/sessions'
import { readArchiveEntries } from './fixtures/archive'
import { listTree, NEVER_EXPORT, removeTempDir, treeHash } from './fixtures/claude-store'
import { createStateDb, insertEdge, spawnEdges, threadRow, threadRows } from './fixtures/codex-db'
import { appendRecord, buildCodexStore, type CodexStore, CX, writeLock, writeNeverExportFiles } from './fixtures/codex-store'
import { type Machine, makeMachine } from './fixtures/machine'

const key = (id: string) => sessionKey('codex', id)
const FAMILY = [CX.parent, CX.subagent, CX.subagent2, CX.grandchild]
const SUBAGENTS = [CX.subagent, CX.subagent2, CX.grandchild]
let a: Machine
let b: Machine
let srcProj: string
let dstProj: string
let src: CodexStore

beforeEach(async () => {
  a = await makeMachine('codex-sub-source')
  b = await makeMachine('codex-sub-target')
  srcProj = path.join(a.home, 'code', 'proj')
  dstProj = path.join(b.home, 'code', 'proj')
  src = await buildCodexStore(a.codexRoot, srcProj)
  await writeNeverExportFiles(a.codexRoot, CX.parent)
})
afterEach(async () => {
  await removeTempDir(a.dir)
  await removeTempDir(b.dir)
})

async function codexSessions(machine: Machine): Promise<Map<string, SessionSummary>> {
  return new Map((await listSessions(machine.context)).sessions.filter((s) => s.agent === 'codex').map((s) => [s.id, s]))
}

async function exportFrom(ids: string[], name = 'out.agentsessions'): Promise<string> {
  const file = path.join(a.dir, name)
  await exportSessions(a.context, ids.map(key), file)
  return file
}

async function importInto(ids: string[], name?: string) {
  const opened = await openArchive(b.context, await exportFrom(ids, name))
  const mappings = suggestMappings(opened.manifest, { homeDir: b.home, sep: path.sep, exists: defaultExists })
  return runImport(b.context, opened, mappings, ids.map(key) as SessionKey[])
}

const at = (machine: Machine, rel: string) => path.join(machine.codexRoot, ...rel.split('/'))
const targetDb = () => path.join(b.codexRoot, 'state_5.sqlite')

describe('Codex subagents in discovery', () => {
  it('nests every subagent under the thread that started it, newest first, and lists an orphan on its own', async () => {
    const byId = await codexSessions(a)
    for (const id of SUBAGENTS) expect(byId.has(id), `${id} is not its own session`).toBe(false)

    const parent = byId.get(CX.parent)!
    expect(parent.subagents).toEqual([
      { id: CX.subagent2, title: 'Map the parser module', role: 'explorer', lastActivity: src.rollouts[CX.subagent2].lastTimestamp },
      { id: CX.grandchild, title: 'Check the edge cases', role: 'deep_check', lastActivity: src.rollouts[CX.grandchild].lastTimestamp },
      { id: CX.subagent, title: 'Review the tokenizer change', role: 'Ada', lastActivity: src.rollouts[CX.subagent].lastTimestamp },
    ])
    const files = [...FAMILY.map((id) => src.rollouts[id].absPath), src.subagentImage]
    const sizes = await Promise.all(files.map(async (file) => (await stat(file)).size))
    const indexLine = Buffer.byteLength(JSON.stringify({ id: CX.parent, thread_name: 'Parent by name', updated_at: '2026-11-01T10:30:00.000Z' }) + '\n')
    expect(parent).toMatchObject({ title: 'Parent by name', live: false, fileCount: files.length + 1, sizeBytes: sizes.reduce((sum, size) => sum + size, indexLine) })

    expect(byId.get(CX.orphan)).toMatchObject({ client: 'subagent', title: 'Lost task', subagents: [], hiddenFromPicker: true })
    expect(byId.get(CX.plain)?.subagents).toEqual([])
  })

  it('marks the session live when only a subagent below it holds a writer lock', async () => {
    await writeLock(a.codexRoot, CX.grandchild)
    const byId = await codexSessions(a)
    expect(byId.get(CX.parent)?.live).toBe(true)
    expect(byId.get(CX.plain)?.live).toBe(false)
  })
})

describe('Codex subagents in export', () => {
  it('exports the parent with every descendant rollout byte for byte, and leaves out never-export files', async () => {
    const before = await treeHash(a.home)
    const entries = await readArchiveEntries(await exportFrom([CX.parent]))
    expect(await treeHash(a.home)).toBe(before)
    for (const content of entries.values()) expect(content.includes(NEVER_EXPORT)).toBe(false)

    const manifest = JSON.parse(entries.get('manifest.json')!.toString())
    expect(manifest.sessions.map((s: { id: string }) => s.id)).toEqual([CX.parent])
    const files = manifest.sessions[0].files as { role: string; path: string; sha256: string }[]
    expect(files.map((f) => `${f.role} ${f.path}`).sort()).toEqual(
      [
        `generated-image generated_images/${CX.subagent2}/call_2.png`,
        'index-entry session_index.jsonl',
        `rollout ${src.rollouts[CX.parent].rel}`,
        ...SUBAGENTS.map((id) => `subagent-rollout ${src.rollouts[id].rel}`),
      ].sort(),
    )
    for (const id of FAMILY) {
      const file = files.find((f) => f.path === src.rollouts[id].rel)!
      expect(entries.get(`blobs/${file.sha256}`), `${id} is byte-exact`).toEqual(await readFile(src.rollouts[id].absPath))
    }
  })

  it('refuses to export a subagent on its own and names the session that holds it', async () => {
    const file = path.join(a.dir, 'sub.agentsessions')
    await expect(exportSessions(a.context, [key(CX.grandchild)], file)).rejects.toThrow(CX.parent)
    expect(await stat(file).catch(() => null)).toBeNull()
  })

  it('exports an orphan subagent as its own session', async () => {
    const entries = await readArchiveEntries(await exportFrom([CX.orphan]))
    const manifest = JSON.parse(entries.get('manifest.json')!.toString())
    expect(manifest.sessions[0].files.map((f: { role: string }) => f.role)).toEqual(['rollout'])
  })
})

describe('Codex subagents imported into an empty store', () => {
  it('places every subagent rollout where Codex looks for it, and lists them under the parent', async () => {
    const [outcome] = (await importInto([CX.parent])).outcomes
    expect(outcome.status).toBe('created')
    for (const id of FAMILY) expect(await readFile(at(b, src.rollouts[id].rel)), `${id} is byte-exact`).toEqual(src.rollouts[id].plain)
    expect(await readFile(path.join(b.codexRoot, 'generated_images', CX.subagent2, 'call_2.png'))).toEqual(await readFile(src.subagentImage))
    expect((await listTree(b.codexRoot)).filter((f) => f.startsWith('state_5'))).toEqual([])

    const listed = await codexSessions(b)
    expect([...listed.keys()]).toEqual([CX.parent])
    expect(listed.get(CX.parent)!.subagents.map((s) => s.id)).toEqual([CX.subagent2, CX.grandchild, CX.subagent])
  })
})

describe('Codex subagents imported into a store with a database', () => {
  beforeEach(async () => {
    await mkdir(b.codexRoot, { recursive: true })
    createStateDb(targetDb(), [{ id: CX.decoy, rollout_path: '/elsewhere/rollout.jsonl', cwd: '/elsewhere', title: 'Decoy', preview: 'Decoy' }])
  })

  it('inserts a row with the mapped cwd and an open spawn edge for every subagent', async () => {
    const decoy = threadRow(targetDb(), CX.decoy)
    expect((await importInto([CX.parent])).outcomes[0].status).toBe('created')
    const realRoot = await realpath(b.codexRoot)
    for (const id of FAMILY) {
      expect(threadRow(targetDb(), id), id).toMatchObject({ cwd: dstProj, rollout_path: path.join(realRoot, ...src.rollouts[id].rel.split('/')) })
    }
    expect(threadRow(targetDb(), CX.subagent)).toMatchObject({ agent_nickname: 'Ada', agent_path: '/root/review', source: expect.stringContaining(`"parent_thread_id":"${CX.parent}"`) })
    expect(spawnEdges(targetDb())).toEqual([
      { parent_thread_id: CX.parent, child_thread_id: CX.subagent, status: 'open' },
      { parent_thread_id: CX.parent, child_thread_id: CX.subagent2, status: 'open' },
      { parent_thread_id: CX.subagent, child_thread_id: CX.grandchild, status: 'open' },
    ])
    expect(threadRow(targetDb(), CX.decoy)).toEqual(decoy)
  })

  it('keeps an edge that is already here, and writes none when the table is missing', async () => {
    insertEdge(targetDb(), CX.parent, CX.subagent, 'closed')
    await importInto([CX.parent])
    expect(spawnEdges(targetDb()).find((edge) => edge.child_thread_id === CX.subagent)).toMatchObject({ status: 'closed' })

    const c = await makeMachine('codex-sub-no-edges')
    try {
      await mkdir(c.codexRoot, { recursive: true })
      createStateDb(path.join(c.codexRoot, 'state_5.sqlite'), [], { edges: false })
      const opened = await openArchive(c.context, await exportFrom([CX.parent], 'c.agentsessions'))
      const mappings = suggestMappings(opened.manifest, { homeDir: c.home, sep: path.sep, exists: defaultExists })
      const [outcome] = (await runImport(c.context, opened, mappings, [key(CX.parent)])).outcomes
      expect(outcome.status).toBe('created')
      expect(threadRows(path.join(c.codexRoot, 'state_5.sqlite')).map((row) => row.id).sort()).toEqual([...FAMILY].sort())
      expect(spawnEdges(path.join(c.codexRoot, 'state_5.sqlite'))).toEqual([])
    } finally {
      await removeTempDir(c.dir)
    }
  })

  it('skips an identical second import and changes nothing', async () => {
    await importInto([CX.parent])
    const after = await treeHash(b.home)
    const rows = threadRows(targetDb())
    const edges = spawnEdges(targetDb())
    const [outcome] = (await importInto([CX.parent], 'again.agentsessions')).outcomes
    expect(outcome.status).toBe('skipped')
    expect(await treeHash(b.home)).toBe(after)
    expect(threadRows(targetDb())).toEqual(rows)
    expect(spawnEdges(targetDb())).toEqual(edges)
  })

  it('updates a subagent that grew since the last import, keeping the old file as a backup', async () => {
    await importInto([CX.parent])
    const target = at(b, src.rollouts[CX.subagent2].rel)
    const old = await readFile(target)
    await appendRecord(src.rollouts[CX.subagent2].absPath, 500, { type: 'token_count', info: { total_token_usage: { total_tokens: 777 } } })
    const [outcome] = (await importInto([CX.parent], 'second.agentsessions')).outcomes
    expect(outcome).toMatchObject({ status: 'updated' })
    expect(await readFile(target)).toEqual(await readFile(src.rollouts[CX.subagent2].absPath))
    expect(await readFile(path.join((outcome as { backupDir: string }).backupDir, ...src.rollouts[CX.subagent2].rel.split('/')))).toEqual(old)
    expect(threadRow(targetDb(), CX.subagent2)).toMatchObject({ tokens_used: 777 })
  })

  it('refuses the whole session when one subagent rollout diverged here', async () => {
    await importInto([CX.parent])
    const grandchild = at(b, src.rollouts[CX.grandchild].rel)
    await writeFile(grandchild, (await readFile(grandchild, 'utf8')).replace('é ✓', 'e !'))
    await appendRecord(src.rollouts[CX.parent].absPath, 500, { type: 'user_message', message: 'one more' })
    const before = await treeHash(b.home)
    const rows = threadRows(targetDb())
    const [outcome] = (await importInto([CX.parent], 'second.agentsessions')).outcomes
    expect(outcome).toMatchObject({ status: 'refused', action: { kind: 'conflict', reason: 'diverged' } })
    expect(await treeHash(b.home)).toBe(before)
    expect(threadRows(targetDb())).toEqual(rows)
  })

  it('blocks the import while a subagent thread is open here', async () => {
    await writeLock(b.codexRoot, CX.grandchild)
    const [outcome] = (await importInto([CX.parent])).outcomes
    expect(outcome).toMatchObject({ status: 'refused', action: { kind: 'blocked', reason: 'live' } })
  })
})
