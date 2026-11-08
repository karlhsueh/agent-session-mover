import { readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exportSessions, listSessions } from '../src/main/core/export'
import { defaultExists, openArchive, type OpenedArchive, previewImport, runImport, suggestMappings } from '../src/main/core/import'
import { type SessionKey, sessionKey } from '../src/shared/sessions'
import { readArchiveEntries } from './fixtures/archive'
import { listTree, NEVER_EXPORT, removeTempDir, treeHash } from './fixtures/claude-store'
import { createStateDb, threadRow, threadRows } from './fixtures/codex-db'
import { appendRecord, buildCodexStore, type CodexStore, CX, writeLock, writeNeverExportFiles } from './fixtures/codex-store'
import { type Machine, makeMachine } from './fixtures/machine'

const key = (id: string) => sessionKey('codex', id)
let a: Machine
let b: Machine
let srcProj: string
let dstProj: string
let src: CodexStore

beforeEach(async () => {
  a = await makeMachine('codex-source')
  b = await makeMachine('codex-target')
  srcProj = path.join(a.home, 'code', 'proj')
  dstProj = path.join(b.home, 'code', 'proj')
  src = await buildCodexStore(a.codexRoot, srcProj)
  await writeNeverExportFiles(a.codexRoot, CX.plain)
})
afterEach(async () => {
  await removeTempDir(a.dir)
  await removeTempDir(b.dir)
})

async function exportFrom(ids: string[], name = 'out.agentsessions'): Promise<string> {
  const file = path.join(a.dir, name)
  await exportSessions(a.context, ids.map(key), file)
  return file
}

async function openIn(archive: string): Promise<{ opened: OpenedArchive; mappings: ReturnType<typeof suggestMappings> }> {
  const opened = await openArchive(b.context, archive)
  return { opened, mappings: suggestMappings(opened.manifest, { homeDir: b.home, sep: '/', exists: defaultExists }) }
}

async function importInto(ids: string[], name?: string) {
  const { opened, mappings } = await openIn(await exportFrom(ids, name))
  return runImport(b.context, opened, mappings, ids.map(key) as SessionKey[])
}

const at = (machine: Machine, rel: string) => path.join(machine.codexRoot, ...rel.replace(/\.zst$/, '').split('/'))
const targetDb = () => path.join(b.codexRoot, 'state_5.sqlite')
const DECOY = { id: CX.decoy, rollout_path: '/elsewhere/rollout.jsonl', cwd: '/elsewhere', title: 'Decoy', preview: 'Decoy' }

describe('Codex export', () => {
  it('reads the store without changing it, keeps rollout bytes as they are, and leaves out never-export files', async () => {
    const before = await treeHash(a.home)
    const archive = await exportFrom([CX.plain, CX.compressed, CX.reverted, CX.child, CX.live])
    expect(await treeHash(a.home)).toBe(before)

    const entries = await readArchiveEntries(archive)
    for (const content of entries.values()) expect(content.includes(NEVER_EXPORT)).toBe(false)
    const manifest = JSON.parse(entries.get('manifest.json')!.toString())
    const files = (id: string) => manifest.sessions.find((s: { id: string }) => s.id === id).files as { role: string; path: string; sha256: string }[]
    const listing = (id: string) => files(id).map((f) => `${f.role} ${f.path}`).sort()

    expect(listing(CX.plain)).toEqual([`generated-image generated_images/${CX.plain}/call_1.png`, 'index-entry session_index.jsonl', `rollout ${src.rollouts[CX.plain].rel}`])
    expect(listing(CX.reverted)).toEqual([`linked-rollout ${src.revertedOriginal.rel}`, `rollout ${src.rollouts[CX.reverted].rel}`])
    expect(listing(CX.child)).toEqual([`linked-rollout ${src.rollouts[CX.parent].rel}`, `rollout ${src.rollouts[CX.child].rel}`])
    const blob = (id: string, role: string) => entries.get(`blobs/${files(id).find((f) => f.role === role)!.sha256}`)!
    expect(src.rollouts[CX.compressed].rel.endsWith('.jsonl.zst')).toBe(true)
    expect(blob(CX.compressed, 'rollout')).toEqual(await readFile(src.rollouts[CX.compressed].absPath))
    expect(blob(CX.plain, 'index-entry').toString()).toBe(src.indexLine + '\n')
    expect(manifest.sessions.find((s: { id: string }) => s.id === CX.plain)).toMatchObject({ agent: 'codex', cwd: srcProj, client: 'cli', title: 'Renamed tokenizer work' })
  })

  it('snapshots a rollout that is being written up to its last complete line', async () => {
    await writeFile(src.rollouts[CX.plain].absPath, Buffer.concat([src.rollouts[CX.plain].plain, Buffer.from('{"timestamp":"2026-11-0')]))
    const entries = await readArchiveEntries(await exportFrom([CX.plain]))
    const manifest = JSON.parse(entries.get('manifest.json')!.toString())
    const rollout = manifest.sessions[0].files.find((f: { role: string }) => f.role === 'rollout')
    expect(entries.get(`blobs/${rollout.sha256}`)).toEqual(src.rollouts[CX.plain].plain)
  })
})

describe('Codex import into an empty store', () => {
  it('writes every file unchanged where Codex looks for it, and no database', async () => {
    const ids = [CX.child, CX.parent, CX.plain, CX.archived, CX.compressed, CX.reverted, CX.orphan]
    const result = await importInto(ids)
    // The child brings its parent's rollout as its linked prefix, so the parent adds only its subagents.
    expect(result.outcomes.map((o) => o.status)).toEqual(['created', 'updated', 'created', 'created', 'created', 'created', 'created'])

    for (const id of ids) expect(await readFile(at(b, src.rollouts[id].rel))).toEqual(src.rollouts[id].plain)
    expect(await readFile(at(b, src.revertedOriginal.rel))).toEqual(src.revertedOriginal.plain)
    expect(src.rollouts[CX.archived].rel.startsWith('archived_sessions/')).toBe(true)
    expect(await readFile(path.join(b.codexRoot, 'generated_images', CX.plain, 'call_1.png'))).toEqual(await readFile(src.imagePath))
    expect((await readFile(path.join(b.codexRoot, 'session_index.jsonl'), 'utf8')).split('\n')).toContain(src.indexLine)
    expect((await stat(at(b, src.rollouts[CX.plain].rel))).mtimeMs).toBe(Date.parse(src.rollouts[CX.plain].lastTimestamp))
    expect((await listTree(b.codexRoot)).filter((f) => f.startsWith('state_5'))).toEqual([])

    const listed = new Map((await listSessions(b.context)).sessions.map((s) => [s.id, s]))
    expect(listed.get(CX.plain)).toMatchObject({ title: 'Renamed tokenizer work', fileCount: 3 })
    expect(listed.get(CX.reverted)).toMatchObject({ title: 'After the revert', fileCount: 2 })
  })

  it('warns that exec and subagent sessions stay out of the resume picker', async () => {
    const { opened, mappings } = await openIn(await exportFrom([CX.plain, CX.compressed, CX.orphan]))
    const warnings = (await previewImport(b.context, opened, mappings)).sessions.map((s) => s.warnings.filter((w) => w.code === 'hidden-from-picker'))
    expect(warnings).toEqual([[], [{ code: 'hidden-from-picker', clientDetail: 'codex_exec' }], [{ code: 'hidden-from-picker', clientDetail: 'codex-tui' }]])
  })
})

describe('Codex import into a store with a database', () => {
  beforeEach(async () => {
    await writeFile(path.join(b.home, '.keep'), '')
    await import('node:fs/promises').then((fs) => fs.mkdir(b.codexRoot, { recursive: true }))
    createStateDb(targetDb(), [DECOY])
  })

  it('inserts a threads row with the mapped cwd and leaves other rows alone', async () => {
    const decoyBefore = threadRow(targetDb(), CX.decoy)
    const result = await importInto([CX.plain, CX.compressed, CX.archived])
    expect(result.outcomes.map((o) => o.status)).toEqual(['created', 'created', 'created'])
    const realRoot = await realpath(b.codexRoot)

    expect(threadRow(targetDb(), CX.plain)).toMatchObject({
      rollout_path: path.join(realRoot, ...src.rollouts[CX.plain].rel.split('/')),
      cwd: dstProj,
      source: 'cli',
      originator: 'codex-tui',
      model_provider: 'openai',
      model: 'gpt-5.5-codex',
      cli_version: '0.162.1',
      title: 'Add a unit test for the tokenizer',
      name: 'Renamed tokenizer work',
      preview: 'Add a unit test for the tokenizer',
      first_user_message: 'Add a unit test for the tokenizer',
      created_at: Date.parse('2026-11-01T10:00:00.000Z') / 1000,
      updated_at_ms: Date.parse(src.rollouts[CX.plain].lastTimestamp),
      recency_at_ms: Date.parse(src.rollouts[CX.plain].lastTimestamp),
      archived: 0,
      has_user_event: 1,
      git_branch: 'main',
    })
    const compressed = threadRow(targetDb(), CX.compressed)!
    expect(compressed).toMatchObject({ source: 'exec', originator: 'codex_exec', rollout_path: path.join(realRoot, ...src.rollouts[CX.compressed].rel.replace(/\.zst$/, '').split('/')) })
    expect(await readFile(compressed.rollout_path as string)).toEqual(src.rollouts[CX.compressed].plain)
    expect(threadRow(targetDb(), CX.archived)).toMatchObject({
      archived: 1,
      archived_at: Math.floor(Date.parse(src.rollouts[CX.archived].lastTimestamp) / 1000),
      source: 'vscode',
      originator: 'Codex Desktop',
      rollout_path: path.join(realRoot, ...src.rollouts[CX.archived].rel.split('/')),
    })
    expect(threadRow(targetDb(), CX.decoy)).toEqual(decoyBefore)

    const listed = (await listSessions(b.context)).sessions.find((s) => s.id === CX.plain)
    expect(listed).toMatchObject({ cwd: dstProj, resumeCommand: `cd '${dstProj}' && codex resume ${CX.plain}` })
  })

  it('gives a fork parent its row when the child brings the parent rollout first', async () => {
    const result = await importInto([CX.child])
    expect(result.outcomes.map((o) => o.status)).toEqual(['created'])
    expect(await readFile(at(b, src.rollouts[CX.parent].rel))).toEqual(src.rollouts[CX.parent].plain)
    expect(threadRow(targetDb(), CX.child)).toMatchObject({ cwd: dstProj, title: 'Forked child' })
    expect(threadRow(targetDb(), CX.parent)).toMatchObject({ cwd: dstProj, title: 'Parent thread', preview: 'Parent thread' })
  })

  it('is idempotent: a second run skips and changes nothing', async () => {
    await importInto([CX.plain, CX.child])
    const after = await treeHash(b.home)
    const rows = threadRows(targetDb())
    const again = await importInto([CX.plain, CX.child], 'again.agentsessions')
    expect(again.outcomes.map((o) => o.status)).toEqual(['skipped', 'skipped'])
    expect(await treeHash(b.home)).toBe(after)
    expect(threadRows(targetDb())).toEqual(rows)
  })

  it('updates a strict prefix, keeps the old file as a backup, and updates the row', async () => {
    await importInto([CX.plain])
    const target = at(b, src.rollouts[CX.plain].rel)
    const old = await readFile(target)
    const rowBefore = threadRow(targetDb(), CX.plain)!
    await appendRecord(src.rollouts[CX.plain].absPath, 500, { type: 'token_count', info: { total_token_usage: { total_tokens: 4321 } } })

    const [outcome] = (await importInto([CX.plain], 'second.agentsessions')).outcomes
    expect(outcome).toMatchObject({ status: 'updated', action: { kind: 'update', backup: true } })
    expect(await readFile(target)).toEqual(await readFile(src.rollouts[CX.plain].absPath))
    const backupDir = (outcome as { backupDir: string }).backupDir
    expect(await readFile(path.join(backupDir, ...src.rollouts[CX.plain].rel.split('/')))).toEqual(old)
    const row = threadRow(targetDb(), CX.plain)!
    expect(row).toMatchObject({ tokens_used: 4321, updated_at_ms: Date.parse('2026-11-01T18:20:00.000Z'), title: rowBefore.title, name: rowBefore.name, created_at_ms: rowBefore.created_at_ms })
  })

  it('updates a copy that Codex compressed here since the last import', async () => {
    await importInto([CX.plain])
    const plainPath = at(b, src.rollouts[CX.plain].rel)
    const zst = zstdCompressSync(await readFile(plainPath))
    await writeFile(`${plainPath}.zst`, zst)
    await unlink(plainPath)

    const same = await importInto([CX.plain], 'same.agentsessions')
    expect(same.outcomes[0].status).toBe('skipped')

    await appendRecord(src.rollouts[CX.plain].absPath, 500, { type: 'user_message', message: 'one more' })
    const [outcome] = (await importInto([CX.plain], 'second.agentsessions')).outcomes
    expect(outcome.status).toBe('updated')
    expect(await readFile(plainPath)).toEqual(await readFile(src.rollouts[CX.plain].absPath))
    expect(await stat(`${plainPath}.zst`).catch(() => null)).toBeNull()
    const backup = path.join((outcome as { backupDir: string }).backupDir, ...`${src.rollouts[CX.plain].rel}.zst`.split('/'))
    expect(await readFile(backup)).toEqual(zst)
  })

  it('refuses a diverged copy and leaves files and rows untouched', async () => {
    await importInto([CX.plain])
    const target = at(b, src.rollouts[CX.plain].rel)
    await writeFile(target, (await readFile(target, 'utf8')).replace('é ✓', 'e !'))
    const before = await treeHash(b.home)
    const rows = threadRows(targetDb())
    const [outcome] = (await importInto([CX.plain], 'second.agentsessions')).outcomes
    expect(outcome).toMatchObject({ status: 'refused', action: { kind: 'conflict', reason: 'diverged' } })
    expect(await treeHash(b.home)).toBe(before)
    expect(threadRows(targetDb())).toEqual(rows)
  })

  it('refuses when this machine has a newer rollout of the thread than the archive', async () => {
    await importInto([CX.reverted])
    const { opened, mappings } = await openIn(await exportFrom([CX.reverted], 'x.agentsessions'))
    await writeFile(at(b, src.rollouts[CX.reverted].rel.replace(/T\d\d-\d\d-\d\d/, 'T23-59-59').replace(CX.revertedRollout, '019a0000-0000-7000-8000-0000000000ff')), src.rollouts[CX.reverted].plain)
    expect((await previewImport(b.context, opened, mappings)).sessions[0].action).toMatchObject({ kind: 'conflict', reason: 'diverged' })
  })

  it('blocks a fork child while its parent thread is open here, since the parent rollout may be written', async () => {
    await writeLock(b.codexRoot, CX.parent)
    const [outcome] = (await importInto([CX.child])).outcomes
    expect(outcome).toMatchObject({ status: 'refused', action: { kind: 'blocked', reason: 'live' } })
  })

  it('blocks a session that is live on this machine', async () => {
    await importInto([CX.plain])
    await appendRecord(src.rollouts[CX.plain].absPath, 500, { type: 'user_message', message: 'more' })
    await writeLock(b.codexRoot, CX.plain)
    const before = await treeHash(b.home)
    const [outcome] = (await importInto([CX.plain], 'second.agentsessions')).outcomes
    expect(outcome).toMatchObject({ status: 'refused', action: { kind: 'blocked', reason: 'live' } })
    expect(await treeHash(b.home)).toBe(before)
  })
})
