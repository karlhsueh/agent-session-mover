import { mkdir, readdir, symlink } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSessionService } from '../src/main/service'
import { type RawEntry, sha256, writeRawArchive } from './fixtures/archive'
import { removeTempDir, treeHash } from './fixtures/claude-store'
import { createStateDb, threadRows } from './fixtures/codex-db'
import { CX, rolloutLines, rolloutRel } from './fixtures/codex-store'
import { type Machine, makeMachine } from './fixtures/machine'

const ID = CX.plain
const CWD = '/Users/eve/proj'
let b: Machine
let file: string

beforeEach(async () => {
  b = await makeMachine('codex-hostile')
  file = path.join(b.dir, 'in.agentsessions')
  await mkdir(b.codexRoot, { recursive: true })
  createStateDb(path.join(b.codexRoot, 'state_5.sqlite'), [])
})
afterEach(async () => removeTempDir(b.dir))

const rollout = Buffer.from(rolloutLines({ id: ID, cwd: CWD }).join('\n') + '\n')
const otherRollout = Buffer.from(rolloutLines({ id: CX.archived, cwd: CWD }).join('\n') + '\n')
const index = (id: string) => Buffer.from(JSON.stringify({ id, thread_name: 'n', updated_at: '2026-11-01T10:00:00Z' }) + '\n')
const entry = (role: string, filePath: string, body: Buffer) => ({ file: { role, path: filePath, sha256: sha256(body), size: body.length, mtimeMs: 0 }, body })

function archive(files: { file: object; body: Buffer }[], sessionId = ID): RawEntry[] {
  const manifest = {
    format: 'agent-sessions-archive',
    version: 1,
    createdAt: '2026-11-07T10:00:00.000Z',
    appVersion: '0.0.0',
    source: { platform: 'darwin', homeDir: '/Users/eve', sep: '/', storeRoots: { codex: '/Users/eve/.codex' } },
    sessions: [
      {
        agent: 'codex',
        id: sessionId,
        title: 't',
        client: 'cli',
        clientDetail: 'codex-tui',
        cwd: CWD,
        cwds: [CWD],
        createdAt: '2026-11-01T10:00:00.000Z',
        lastActivity: '2026-11-01T11:00:00.000Z',
        cliVersion: '0.162.1',
        files: files.map((f) => f.file),
      },
    ],
  }
  const blobs = new Map(files.map((f) => [sha256(f.body), f.body]))
  return [{ name: 'manifest.json', body: JSON.stringify(manifest) }, ...[...blobs].map(([sha, body]) => ({ name: `blobs/${sha}`, body }))]
}

async function importArchive(entries: RawEntry[]) {
  await writeRawArchive(file, entries)
  const service = createSessionService(b.context)
  const opened = await service.openArchive(async () => file, () => {})
  if (!opened.ok || opened.value.kind !== 'opened') throw new Error('archive did not open')
  const mappings = [{ source: CWD, target: path.join(b.home, 'proj') }]
  const preview = await service.previewImport(opened.value.token, mappings)
  const run = await service.runImport(opened.value.token, mappings, [`codex:${ID}`], () => {})
  return { preview, run }
}

describe('Codex import of a valid archive with hostile intent', () => {
  it.each<[string, () => { file: object; body: Buffer }[]]>([
    ['a rollout stored at a never-export path', () => [entry('rollout', 'auth.json', rollout)]],
    ['a rollout outside sessions/', () => [entry('rollout', `shell_snapshots/rollout-2026-11-01T10-00-00-${ID}.jsonl`, rollout)]],
    ['a rollout named for another thread', () => [entry('rollout', rolloutRel({ id: CX.archived, cwd: CWD }), rollout)]],
    ['a rollout whose content is another thread', () => [entry('rollout', rolloutRel({ id: ID, cwd: CWD }), otherRollout)]],
    ['two main rollouts', () => [entry('rollout', rolloutRel({ id: ID, cwd: CWD }), rollout), entry('rollout', rolloutRel({ id: ID, cwd: CWD, rolloutId: CX.revertedRollout }), rollout)]],
    ['an image filed under another thread', () => [entry('rollout', rolloutRel({ id: ID, cwd: CWD }), rollout), entry('generated-image', `generated_images/${CX.archived}/a.png`, Buffer.from('x'))]],
    ['an index entry for another thread', () => [entry('rollout', rolloutRel({ id: ID, cwd: CWD }), rollout), entry('index-entry', 'session_index.jsonl', index(CX.archived))]],
    ['an index entry of two lines', () => [entry('rollout', rolloutRel({ id: ID, cwd: CWD }), rollout), entry('index-entry', 'session_index.jsonl', Buffer.concat([index(ID), index(ID)]))]],
    ['a compressed rollout that is not zstd', () => [entry('rollout', rolloutRel({ id: ID, cwd: CWD, compressed: true }), Buffer.from('not zstd at all'))]],
    ['an index entry at another path',() => [entry('rollout', rolloutRel({ id: ID, cwd: CWD }), rollout), entry('index-entry', 'config.toml', index(ID))]],
  ])('blocks %s and writes nothing', async (_name, files) => {
    const before = await treeHash(b.home)
    const { preview, run } = await importArchive(archive(files()))
    expect(preview).toMatchObject({ ok: true, value: { sessions: [{ action: { kind: 'blocked', reason: 'invalid-session' } }] } })
    expect(run).toMatchObject({ ok: true, value: { outcomes: [{ status: 'refused' }] } })
    expect(await treeHash(b.home)).toBe(before)
  })

  it('blocks a date folder that is a symlink out of the store, and writes no row', async () => {
    const outside = path.join(b.dir, 'outside')
    await mkdir(outside)
    await mkdir(path.join(b.codexRoot, 'sessions', '2026', '11'), { recursive: true })
    await symlink(outside, path.join(b.codexRoot, 'sessions', '2026', '11', '01'))
    const { preview, run } = await importArchive(archive([entry('rollout', rolloutRel({ id: ID, cwd: CWD }), rollout)]))
    expect(preview).toMatchObject({ ok: true, value: { sessions: [{ action: { kind: 'blocked', reason: 'unsafe-path' } }] } })
    expect(run).toMatchObject({ ok: true, value: { outcomes: [{ status: 'refused' }] } })
    expect(await readdir(outside)).toEqual([])
    expect(threadRows(path.join(b.codexRoot, 'state_5.sqlite'))).toEqual([])
  })
})
