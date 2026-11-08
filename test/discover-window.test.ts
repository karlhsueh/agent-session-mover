import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listSessions } from '../src/main/core/discovery'
import { GAP, LIST_BUDGET, readWindow, type TranscriptSource } from '../src/main/core/window'
import { providers } from '../src/main/providers/registry'
import type { SessionSummary } from '../src/shared/sessions'
import { removeTempDir, transcriptRecords, writeSession } from './fixtures/claude-store'
import { buildCodexStore, rolloutLines, rolloutRel } from './fixtures/codex-store'
import { type Machine, makeMachine } from './fixtures/machine'

let machine: Machine
beforeEach(async () => {
  machine = await makeMachine('discover-window')
})
afterEach(async () => removeTempDir(machine.dir))

const MiB = 1024 * 1024
const pad = (bytes: number) => 'x'.repeat(bytes)

async function* chunked(bytes: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let start = 0; start < bytes.length; start += size) yield bytes.subarray(start, start + size)
}

/** Records of about 64 KB each until `bytes`, so a long transcript's middle can hold a folder the head and tail never mention. */
function bulk(bytes: number, record: (index: number) => Record<string, unknown>): string[] {
  return Array.from({ length: Math.ceil(bytes / (64 * 1024)) }, (_, index) => JSON.stringify({ ...record(index), padding: pad(64 * 1024) }))
}

/** The fields discovery and export both derive from the transcript. */
function described(session: Pick<SessionSummary, 'title' | 'cwd' | 'cwds' | 'createdAt' | 'lastActivity' | 'cliVersion' | 'client' | 'clientDetail'>) {
  const { title, cwd, cwds, createdAt, lastActivity, cliVersion, client, clientDetail } = session
  return { title, cwd, cwds, createdAt, lastActivity, cliVersion, client, clientDetail }
}

describe('a bounded read window', () => {
  const budget = { maxBytes: 64 * 1024, tailBytes: 16 * 1024 }
  const lines = Array.from({ length: 2000 }, (_, index) => `{"n":${index},"pad":"${pad(90)}"}`)

  it.each(['file', 'stream'] as const)('hands a %s at most the budget, as its head and tail lines in order', async (kind) => {
    const bytes = Buffer.from(lines.join('\n') + '\n')
    const absPath = path.join(machine.dir, 'long.jsonl')
    await writeFile(absPath, bytes)
    const source: TranscriptSource = kind === 'file' ? { kind, absPath } : { kind, chunks: chunked(bytes, 70_000) }
    const seen: string[] = []
    let gaps = 0
    for await (const line of readWindow(source, budget)) {
      if (line === GAP) gaps += 1
      else seen.push(line.toString())
    }
    expect(gaps).toBe(1)
    expect(seen.reduce((sum, line) => sum + line.length + 1, 0)).toBeLessThanOrEqual(budget.maxBytes)
    expect(seen[0]).toBe(lines[0])
    expect(seen.at(-1)).toBe(lines.at(-1))
    const cut = seen.findIndex((line, index) => line !== lines[index])
    expect(seen.slice(cut)).toEqual(lines.slice(lines.length - (seen.length - cut)))
  })
})

describe('listing a transcript too long to read whole', () => {
  it('takes the start from the head and the latest activity from the tail, and says its folders may be incomplete', async () => {
    const id = '7a000000-0000-4000-8000-000000000001'
    const proj = path.join(machine.home, 'code', 'proj')
    const other = path.join(machine.home, 'code', 'other-checkout')
    const built = await writeSession(machine.root, { id, cwd: proj })
    const { lines } = transcriptRecords(machine.root, { id, cwd: proj })
    const record = (cwd: string) => (index: number) => ({ type: 'progress', cwd, sessionId: id, timestamp: `2026-11-02T00:00:${String(index % 60).padStart(2, '0')}.000Z` })
    const lastActivity = '2026-11-03T08:00:00.000Z'
    const body = [
      ...lines,
      ...bulk(LIST_BUDGET.maxBytes, record(proj)),
      ...bulk(MiB, record(other)),
      ...bulk(LIST_BUDGET.tailBytes * 2, record(proj)),
      JSON.stringify({ type: 'ai-title', sessionId: id, aiTitle: 'Renamed near the end' }),
      JSON.stringify({ type: 'assistant', cwd: proj, sessionId: id, version: '2.1.400', timestamp: lastActivity, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } }),
    ]
    await writeFile(built.transcriptPath, body.join('\n') + '\n')

    const [listed] = (await listSessions(machine.context)).sessions
    expect(listed).toMatchObject({ id, title: 'Renamed near the end', cwd: proj, cwds: [proj], cwdsComplete: false, createdAt: '2026-11-01T10:00:00.000Z', lastActivity, cliVersion: '2.1.400' })
    const exported = await providers['claude-code'].collect(machine.root, id, machine.context.env)
    expect(exported.session.cwds, 'export reads every line').toEqual([proj, other])
  })

  it.each([false, true])('reads a long Codex rollout the same way, compressed: %s', async (compressed) => {
    const id = '019a0000-0000-7000-8000-0000000000aa'
    const cwd = path.join(machine.home, 'code', 'proj')
    const rollout = { id, cwd, prompt: 'Port the tokenizer', compressed }
    const head = rolloutLines(rollout)
    const turn = (where: string) => (index: number) => ({ timestamp: `2026-11-02T00:00:${String(index % 60).padStart(2, '0')}.000Z`, ordinal: 100 + index, type: 'turn_context', payload: { cwd: where, model: 'gpt-5.5-codex' } })
    const lastActivity = '2026-11-03T08:00:00.000Z'
    const body = [
      ...head,
      ...bulk(LIST_BUDGET.maxBytes, turn(cwd)),
      ...bulk(MiB, turn(`${cwd}-worktree`)),
      ...bulk(LIST_BUDGET.tailBytes * 2, turn(cwd)),
      JSON.stringify({ timestamp: lastActivity, ordinal: 99_999, type: 'event_msg', payload: { type: 'token_count', info: null } }),
    ]
    const plain = Buffer.from(body.join('\n') + '\n')
    const absPath = path.join(machine.codexRoot, ...rolloutRel(rollout).split('/'))
    await mkdir(path.dirname(absPath), { recursive: true })
    await writeFile(absPath, compressed ? zstdCompressSync(plain) : plain)

    const [listed] = (await listSessions(machine.context)).sessions
    expect(listed).toMatchObject({ id, title: 'Port the tokenizer', cwd, cwds: [cwd], cwdsComplete: false, createdAt: '2026-11-01T10:00:00.000Z', lastActivity })
    const exported = await providers.codex.collect(machine.codexRoot, id, machine.context.env)
    expect(exported.session.cwds, 'export reads every line').toEqual([cwd, `${cwd}-worktree`])
  })
})

describe('listing a transcript within the budget', () => {
  it('derives the same fields an export does, for every session shape', async () => {
    const proj = path.join(machine.home, 'code', 'proj')
    await writeSession(machine.root, { id: '7b000000-0000-4000-8000-000000000001', cwd: proj, subagents: true, toolResult: true, customTitle: 'Renamed' })
    await writeSession(machine.root, { id: '7b000000-0000-4000-8000-000000000002', cwd: proj, resumedFrom: path.join(machine.home, 'elsewhere') })
    await writeSession(machine.root, { id: '7b000000-0000-4000-8000-000000000003', cwd: proj, entrypoint: 'sdk-cli', halfWrittenLastLine: true })
    await buildCodexStore(machine.codexRoot, proj)

    const { sessions, problems } = await listSessions(machine.context)
    expect(problems).toEqual([])
    expect(sessions.length).toBe(11)
    for (const session of sessions) {
      const provider = providers[session.agent]
      const exported = await provider.collect(provider.storeRoot(machine.context.env), session.id, machine.context.env)
      expect(session.cwdsComplete).toBe(true)
      expect(described(session), session.key).toEqual(described(exported.session))
    }
  })
})
