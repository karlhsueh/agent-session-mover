import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listSessions } from '../src/main/core/discovery'
import { claudeCodeProvider } from '../src/main/providers/claude-code'
import { DEAD_PID, removeTempDir, writeLiveEntry, writeNeverExportFiles, writeSession } from './fixtures/claude-store'
import { type Machine, makeMachine, shellQuoted } from './fixtures/machine'

const ID = {
  plain: '0a000000-0000-4000-8000-000000000001',
  resumed: '0b000000-0000-4000-8000-000000000002',
  sdk: '0c000000-0000-4000-8000-000000000003',
  live: '0d000000-0000-4000-8000-000000000004',
  long: '0e000000-0000-4000-8000-000000000005',
  dead: '0f000000-0000-4000-8000-000000000006',
}

let machine: Machine
beforeEach(async () => {
  machine = await makeMachine('discover')
})
afterEach(async () => removeTempDir(machine.dir))

describe('Claude Code discovery', () => {
  it('lists each transcript with its derived fields and skips everything else', async () => {
    const { root, home } = machine
    const proj = path.join(home, 'code', 'proj')
    const other = path.join(home, 'code', 'other')
    const longCwd = path.join(home, ...Array.from({ length: 8 }, (_, i) => `deeply-nested-folder-number-${i}`))
    await writeSession(root, { id: ID.plain, cwd: proj, subagents: true, toolResult: true, customTitle: 'Renamed by user' })
    await writeSession(root, { id: ID.resumed, cwd: proj, resumedFrom: other, startMinute: 100 })
    await writeSession(root, { id: ID.sdk, cwd: other, entrypoint: 'sdk-cli', halfWrittenLastLine: true })
    await writeSession(root, { id: ID.live, cwd: other, entrypoint: 'claude-desktop' })
    await writeSession(root, { id: ID.long, cwd: longCwd, entrypoint: 'claude-vscode' })
    await writeSession(root, { id: ID.dead, cwd: proj })
    await writeLiveEntry(root, process.pid, ID.live)
    await writeLiveEntry(root, DEAD_PID, ID.dead)
    await writeNeverExportFiles(root, { id: ID.plain, cwd: proj })

    const list = await listSessions(machine.context)
    expect(list.problems).toEqual([])
    const byId = new Map(list.sessions.map((s) => [s.id, s]))
    expect([...byId.keys()].sort()).toEqual(Object.values(ID).sort())

    const plain = byId.get(ID.plain)!
    expect(plain).toMatchObject({
      key: `claude-code:${ID.plain}`,
      agent: 'claude-code',
      client: 'cli',
      clientDetail: 'cli',
      title: 'Renamed by user',
      cwd: proj,
      cwds: [proj],
      createdAt: '2026-11-01T10:00:00.000Z',
      cliVersion: '2.1.319',
      gitBranch: 'main',
      live: false,
      archived: false,
      fileCount: 4,
      resumeCommand: `cd ${shellQuoted(proj)} && claude --resume ${ID.plain}`,
    })

    expect(byId.get(ID.resumed)).toMatchObject({ cwd: proj, cwds: [proj, other], title: 'Tokenizer test', createdAt: '2026-11-01T11:40:00.000Z' })
    expect(byId.get(ID.sdk)).toMatchObject({ client: 'sdk', clientDetail: 'sdk-cli', hiddenFromPicker: true })
    expect(byId.get(ID.plain)?.hiddenFromPicker, 'a cli session shows in the picker').toBe(false)
    expect(byId.get(ID.live)).toMatchObject({ client: 'desktop', live: true })
    expect(byId.get(ID.dead)).toMatchObject({ live: false })
    expect(byId.get(ID.long)).toMatchObject({ client: 'ide', cwd: longCwd })
  })

  it('takes the first user prompt as the title when the session has no title records', async () => {
    const id = '1a000000-0000-4000-8000-000000000001'
    await writeSession(machine.root, { id, cwd: '/w' })
    const file = path.join(machine.root, 'projects', '-w', `${id}.jsonl`)
    const { readFile, writeFile } = await import('node:fs/promises')
    const kept = (await readFile(file, 'utf8')).split('\n').filter((line) => !line.includes('"ai-title"'))
    await writeFile(file, kept.join('\n'))
    const [session] = await claudeCodeProvider.discover(machine.root, machine.context.env)
    expect(session.title).toBe('Add a unit test for the tokenizer')
  })

  it('reports the branch at the last record that names one, in the listing and in an export', async () => {
    const { readFile, writeFile } = await import('node:fs/promises')
    const ids = { switched: '2a000000-0000-4000-8000-000000000001', emptyLast: '2b000000-0000-4000-8000-000000000002', none: '2c000000-0000-4000-8000-000000000003' }
    await writeSession(machine.root, { id: ids.switched, cwd: '/w', finalBranch: 'feature/x' })
    await writeSession(machine.root, { id: ids.emptyLast, cwd: '/w', finalBranch: '' })
    await writeSession(machine.root, { id: ids.none, cwd: '/w' })
    const file = path.join(machine.root, 'projects', '-w', `${ids.none}.jsonl`)
    await writeFile(file, (await readFile(file, 'utf8')).replaceAll('"gitBranch":"main",', ''))

    const listed = new Map((await claudeCodeProvider.discover(machine.root, machine.context.env)).map((s) => [s.id, s.gitBranch]))
    const expected = { [ids.switched]: 'feature/x', [ids.emptyLast]: 'main', [ids.none]: null }
    expect(Object.fromEntries(listed)).toEqual(expected)
    for (const [id, branch] of Object.entries(expected)) {
      expect((await claudeCodeProvider.collect(machine.root, id, machine.context.env)).session.gitBranch).toBe(branch)
    }
  })

  it('returns nothing for a store that does not exist', async () => {
    expect(await claudeCodeProvider.discover(path.join(machine.dir, 'missing'), machine.context.env)).toEqual([])
  })

  it('honors CLAUDE_CONFIG_DIR over the home folder', () => {
    expect(claudeCodeProvider.storeRoot({ homeDir: '/Users/a', env: {}, platform: 'darwin' })).toBe(path.resolve('/Users/a/.claude'))
    expect(claudeCodeProvider.storeRoot({ homeDir: '/Users/a', env: { CLAUDE_CONFIG_DIR: '/data/claude' }, platform: 'darwin' })).toBe(path.resolve('/data/claude'))
  })
})
