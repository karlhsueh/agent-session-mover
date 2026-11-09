import { mkdir, rename } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listSessions } from '../src/main/core/discovery'
import { codexProvider } from '../src/main/providers/codex'
import { removeTempDir, treeHash } from './fixtures/claude-store'
import { buildCodexStore, type CodexStore, CX, writeNeverExportFiles, writeRollout } from './fixtures/codex-store'
import { type Machine, makeMachine, shellQuoted } from './fixtures/machine'

let machine: Machine
let cwd: string
let store: CodexStore
beforeEach(async () => {
  machine = await makeMachine('codex-discover')
  cwd = path.join(machine.home, 'code', 'proj')
  store = await buildCodexStore(machine.codexRoot, cwd)
  await writeNeverExportFiles(machine.codexRoot, CX.plain)
})
afterEach(async () => removeTempDir(machine.dir))

describe('Codex discovery', () => {
  it('lists one session per thread that no local thread spawned, with its derived fields, and changes nothing', async () => {
    const before = await treeHash(machine.home)
    const list = await listSessions(machine.context)
    expect(await treeHash(machine.home)).toBe(before)
    expect(list.problems).toEqual([])
    const byId = new Map(list.sessions.filter((s) => s.agent === 'codex').map((s) => [s.id, s]))
    expect([...byId.keys()].sort()).toEqual([CX.plain, CX.archived, CX.compressed, CX.reverted, CX.parent, CX.child, CX.live, CX.orphan].sort())

    expect(byId.get(CX.plain)).toMatchObject({
      key: `codex:${CX.plain}`,
      client: 'cli',
      clientDetail: 'codex-tui',
      title: 'Renamed tokenizer work',
      cwd,
      cwds: [cwd],
      createdAt: '2026-11-01T10:00:00.000Z',
      lastActivity: store.rollouts[CX.plain].lastTimestamp,
      cliVersion: '0.162.1',
      gitBranch: 'main',
      fileCount: 3,
      live: false,
      archived: false,
      resumeCommand: `cd ${shellQuoted(cwd)} && codex resume ${CX.plain}`,
    })
    expect(byId.get(CX.archived)).toMatchObject({ archived: true, client: 'desktop', clientDetail: 'Codex Desktop', title: 'Database title for archived' })
    expect(byId.get(CX.plain)?.hiddenFromPicker, 'a cli session shows in the picker').toBe(false)
    expect(byId.get(CX.orphan)?.hiddenFromPicker, 'a subagent session is skipped by the picker').toBe(true)
    expect(byId.get(CX.compressed)).toMatchObject({ hiddenFromPicker: true, client: 'exec', title: 'Run the exec job', fileCount: 1, lastActivity: store.rollouts[CX.compressed].lastTimestamp })
    expect(byId.get(CX.reverted)).toMatchObject({ title: 'After the revert', fileCount: 2 })
    expect(byId.get(CX.child)).toMatchObject({ title: 'Forked child', fileCount: 2 })
    expect(byId.get(CX.parent)).toMatchObject({ title: 'Parent by name' })
    expect(byId.get(CX.orphan)).toMatchObject({ client: 'subagent', title: 'Lost task', subagents: [] })
    expect(byId.get(CX.live)).toMatchObject({ live: true })
  })

  it('reads the database again after Codex changes it', async () => {
    const title = async () => (await listSessions(machine.context)).sessions.find((s) => s.id === CX.archived)?.title
    expect(await title()).toBe('Database title for archived')
    const db = new DatabaseSync(path.join(machine.codexRoot, 'state_5.sqlite'))
    db.prepare('UPDATE threads SET title = ? WHERE id = ?').run('Retitled in Codex', CX.archived)
    db.close()
    expect(await title()).toBe('Retitled in Codex')
  })

  it('reports the branch session_meta records, and null outside a repo', async () => {
    const ids = { feature: '019a0000-0000-7000-8000-0000000000b1', none: '019a0000-0000-7000-8000-0000000000b2' }
    await writeRollout(machine.codexRoot, { id: ids.feature, cwd, startMinute: 300, branch: 'feature/x' })
    await writeRollout(machine.codexRoot, { id: ids.none, cwd, startMinute: 320, branch: null })
    const listed = new Map((await codexProvider.discover(machine.codexRoot, machine.context.env)).map((s) => [s.id, s.gitBranch]))
    expect([listed.get(ids.feature), listed.get(ids.none)]).toEqual(['feature/x', null])
    expect((await codexProvider.collect(machine.codexRoot, ids.feature, machine.context.env)).session.gitBranch).toBe('feature/x')
    expect((await codexProvider.collect(machine.codexRoot, ids.none, machine.context.env)).session.gitBranch).toBeNull()
  })

  it('returns nothing for a store that does not exist', async () => {
    expect(await codexProvider.discover(path.join(machine.dir, 'missing'), machine.context.env)).toEqual([])
  })

  it('honors CODEX_HOME, and reads the database from CODEX_SQLITE_HOME', async () => {
    expect(codexProvider.storeRoot({ homeDir: '/Users/a', env: {}, platform: 'darwin' })).toBe(path.resolve('/Users/a/.codex'))
    expect(codexProvider.storeRoot({ homeDir: '/Users/a', env: { CODEX_HOME: '/data/codex' }, platform: 'darwin' })).toBe(path.resolve('/data/codex'))

    const sqliteHome = path.join(machine.dir, 'sqlite-home')
    await mkdir(sqliteHome)
    await rename(store.db, path.join(sqliteHome, 'state_5.sqlite'))
    const title = async (env: Record<string, string>) =>
      (await codexProvider.discover(machine.codexRoot, { ...machine.context.env, env })).find((s) => s.id === CX.archived)?.title
    expect(await title({})).toBe('Archive me')
    expect(await title({ CODEX_SQLITE_HOME: sqliteHome })).toBe('Database title for archived')
  })
})
