import { chmod, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDiscovery, listSessions } from '../src/main/core/discovery'
import type { Provider } from '../src/main/core/provider'
import { providers } from '../src/main/providers/registry'
import { removeTempDir, writeSession } from './fixtures/claude-store'
import { buildCodexStore, CX } from './fixtures/codex-store'
import { type Machine, makeMachine } from './fixtures/machine'

const ID = { a: '8a000000-0000-4000-8000-000000000001', b: '8b000000-0000-4000-8000-000000000002', c: '8c000000-0000-4000-8000-000000000003' }

let machine: Machine
let proj: string
let locked: string[] = []
beforeEach(async () => {
  machine = await makeMachine('discovery-cache')
  proj = path.join(machine.home, 'code', 'proj')
  await writeSession(machine.root, { id: ID.a, cwd: proj, subagents: true, toolResult: true })
  await writeSession(machine.root, { id: ID.b, cwd: proj, resumedFrom: path.join(machine.home, 'elsewhere'), startMinute: 30 })
  await buildCodexStore(machine.codexRoot, proj)
})
afterEach(async () => {
  for (const file of locked) await chmod(file, 0o644).catch(() => undefined)
  locked = []
  await removeTempDir(machine.dir)
})

const transcript = (id: string) => path.join(machine.root, 'projects', proj.replace(/[^A-Za-z0-9]/g, '-'), `${id}.jsonl`)
const titles = async () => Object.fromEntries((await listSessions(machine.context)).sessions.map((session) => [session.id, session.title]))

/** Unreadable, with the size and mtime it had. A pass that reads it fails, so listing it proves it was not read. */
async function lock(file: string): Promise<void> {
  await chmod(file, 0o000)
  locked.push(file)
}

async function uncached() {
  const sessions = []
  for (const provider of Object.values(providers)) sessions.push(...(await provider.discover(provider.storeRoot(machine.context.env), machine.context.env)))
  return sessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
}

describe('the discovery cache', () => {
  it('lists exactly what a full read lists, on the first launch and the next', async () => {
    const expected = await uncached()
    const first = await listSessions(machine.context)
    const second = await listSessions(machine.context)
    expect(first).toEqual({ sessions: expected, problems: [] })
    expect(second).toEqual(first)
  })

  it('reads only the files that changed since the last pass', async () => {
    await listSessions(machine.context)
    await lock(transcript(ID.a))
    for (const file of await codexRollouts()) await lock(file)
    await writeFile(transcript(ID.b), (await readFile(transcript(ID.b), 'utf8')) + JSON.stringify({ type: 'custom-title', sessionId: ID.b, customTitle: 'Renamed after launch' }) + '\n')

    const list = await listSessions(machine.context)
    expect(list.problems).toEqual([])
    const byId = new Map(list.sessions.map((session) => [session.id, session]))
    expect(byId.get(ID.a)?.title, 'an unchanged transcript comes from the cache').toBe('Tokenizer test')
    expect(byId.get(CX.plain)?.title, 'so does an unchanged rollout').toBe('Renamed tokenizer work')
    expect(byId.get(ID.b)?.title, 'a changed transcript is read again').toBe('Renamed after launch')
  })

  it('reads a file again when a rewrite keeps its size but moves its mtime', async () => {
    const file = transcript(ID.c)
    await writeSession(machine.root, { id: ID.c, cwd: proj, aiTitle: 'Title one' })
    expect((await titles())[ID.c]).toBe('Title one')
    await writeFile(file, (await readFile(file, 'utf8')).replace('Title one', 'Title two'))
    await utimes(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
    expect((await titles())[ID.c]).toBe('Title two')
  })

  it('reads a file again when another one takes the place of a file that vanished', async () => {
    const file = transcript(ID.c)
    await writeSession(machine.root, { id: ID.c, cwd: proj, aiTitle: 'First title' })
    const { mtime } = await stat(file)
    expect((await titles())[ID.c]).toBe('First title')
    await rm(file)
    expect((await titles())[ID.c]).toBeUndefined()
    await writeSession(machine.root, { id: ID.c, cwd: proj, aiTitle: 'Other title' })
    await utimes(file, mtime, mtime)
    expect((await titles())[ID.c]).toBe('Other title')
  })

  it('ignores a corrupt cache file and lists every store', async () => {
    const expected = await uncached()
    await listSessions(machine.context)
    for (const agent of ['claude-code', 'codex']) await writeFile(path.join(machine.appData, 'discovery', `${agent}.json`), '{"format":"agent-sessions-disc')
    expect(await listSessions(machine.context)).toEqual({ sessions: expected, problems: [] })
  })

  it('drops facts kept by an older parser version', async () => {
    await withProvider({ factsVersion: providers['claude-code'].factsVersion - 1, title: 'Stale title' })
    expect((await titles())[ID.a]).toBe('Tokenizer test')
  })

  it('reads every file again when kept facts of the current version are malformed', async () => {
    await withProvider({ factsVersion: providers['claude-code'].factsVersion, facts: 42 })
    const list = await listSessions(machine.context)
    expect(list.problems).toEqual([])
    expect(list.sessions.find((session) => session.id === ID.a)?.title).toBe('Tokenizer test')
  })

  it('gives a list call made during a pass the result of a pass that starts after it', async () => {
    const discovery = createDiscovery(machine.context)
    const first = discovery.list('claude-code')
    await writeSession(machine.root, { id: ID.c, cwd: proj, aiTitle: 'Created during the scan' })
    const second = discovery.list('claude-code')
    await first
    expect((await second).sessions.map((session) => session.id)).toContain(ID.c)
  })
})

async function codexRollouts(): Promise<string[]> {
  const day = path.join(machine.codexRoot, 'sessions', '2026', '11', '01')
  return (await readdir(day)).filter((name) => name.includes(CX.plain)).map((name) => path.join(day, name))
}

/** Runs one pass with a Claude provider that keeps doctored facts, the way an older or broken build would have. */
async function withProvider(options: { factsVersion: number; title?: string; facts?: unknown }): Promise<void> {
  const real = providers['claude-code']
  const doctored: Provider = {
    ...real,
    factsVersion: options.factsVersion,
    discover: (root, env, scan) =>
      real.discover(root, env, {
        expect: () => undefined,
        facts: async (kind, file, derive) => {
          const facts = await derive()
          const kept = kind !== 'transcript' ? facts : (options.facts ?? { ...(facts as object), aiTitle: options.title })
          await scan!.facts(kind, file, async () => kept)
          return facts
        },
      }),
  }
  await mkdir(machine.appData, { recursive: true })
  await listSessions({ ...machine.context, providers: { ...providers, 'claude-code': doctored } })
}
