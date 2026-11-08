import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listSessions } from '../src/main/core/export'
import { claudeCodeProvider } from '../src/main/providers/claude-code'
import { DEAD_PID, removeTempDir, writeLiveEntry, writeNeverExportFiles, writeSession } from './fixtures/claude-store'
import { type Machine, makeMachine } from './fixtures/machine'

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
      live: false,
      archived: false,
      fileCount: 4,
      resumeCommand: `cd '${proj}' && claude --resume ${ID.plain}`,
    })

    expect(byId.get(ID.resumed)).toMatchObject({ cwd: proj, cwds: [proj, other], title: 'Tokenizer test', createdAt: '2026-11-01T11:40:00.000Z' })
    expect(byId.get(ID.sdk)).toMatchObject({ client: 'sdk', clientDetail: 'sdk-cli' })
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

  it('returns nothing for a store that does not exist', async () => {
    expect(await claudeCodeProvider.discover(path.join(machine.dir, 'missing'), machine.context.env)).toEqual([])
  })

  it('honors CLAUDE_CONFIG_DIR over the home folder', () => {
    expect(claudeCodeProvider.storeRoot({ homeDir: '/Users/a', env: {}, platform: 'darwin' })).toBe('/Users/a/.claude')
    expect(claudeCodeProvider.storeRoot({ homeDir: '/Users/a', env: { CLAUDE_CONFIG_DIR: '/data/claude' }, platform: 'darwin' })).toBe('/data/claude')
  })
})
