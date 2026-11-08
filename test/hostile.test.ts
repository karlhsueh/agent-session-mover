import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_LIMITS } from '../src/main/archive/archive'
import { createSessionService } from '../src/main/service'
import { encodeProjectDir } from '../src/main/providers/claude-code/encode'
import { type RawEntry, rawTar, sha256, writeRawArchive } from './fixtures/archive'
import { removeTempDir, transcriptRecords, treeHash } from './fixtures/claude-store'
import { type Machine, makeMachine } from './fixtures/machine'

const ID = '4a000000-0000-4000-8000-000000000001'
let b: Machine
let file: string

beforeEach(async () => {
  b = await makeMachine('hostile')
  file = path.join(b.dir, 'in.agentsessions')
  await mkdir(path.join(b.root, 'projects'), { recursive: true })
})
afterEach(async () => removeTempDir(b.dir))

const transcript = Buffer.from(transcriptRecords('/Users/eve/.claude', { id: ID, cwd: '/Users/eve/proj' }).lines.join('\n') + '\n')
const SHA = sha256(transcript)

function manifest(overrides: { version?: number; files?: unknown[]; sessionId?: string } = {}) {
  return {
    format: 'agent-sessions-archive',
    version: overrides.version ?? 1,
    createdAt: '2026-11-07T10:00:00.000Z',
    appVersion: '0.0.0',
    source: { platform: 'darwin', homeDir: '/Users/eve', sep: '/', storeRoots: { 'claude-code': '/Users/eve/.claude' } },
    sessions: [
      {
        agent: 'claude-code',
        id: overrides.sessionId ?? ID,
        title: 't',
        client: 'cli',
        clientDetail: 'cli',
        cwd: '/Users/eve/proj',
        cwds: ['/Users/eve/proj'],
        createdAt: '2026-11-01T10:00:00.000Z',
        lastActivity: '2026-11-01T11:00:00.000Z',
        cliVersion: '2.1.319',
        files: overrides.files ?? [{ role: 'transcript', path: `projects/-Users-eve-proj/${ID}.jsonl`, sha256: SHA, size: transcript.length, mtimeMs: 0 }],
      },
    ],
  }
}

const manifestEntry = (value: unknown = manifest()): RawEntry => ({ name: 'manifest.json', body: JSON.stringify(value) })
const blobEntry: RawEntry = { name: `blobs/${SHA}`, body: transcript }

async function open(limits = DEFAULT_LIMITS) {
  const service = createSessionService(b.context, { limits })
  return service.openArchive(async () => file, () => {})
}

async function expectRejected(limits = DEFAULT_LIMITS): Promise<void> {
  const before = await treeHash(b.home)
  const result = await open(limits)
  expect(result).toMatchObject({ ok: false, error: { code: 'invalid-archive' } })
  expect(await treeHash(b.home)).toBe(before)
  expect(await readdir(path.join(b.appData, 'staging')).catch(() => [])).toEqual([])
}

describe('archive reader', () => {
  it('accepts a well-formed archive built by an independent tar writer', async () => {
    await writeRawArchive(file, [manifestEntry(), blobEntry])
    expect(await open()).toMatchObject({ ok: true, value: { kind: 'opened' } })
  })

  it.each<[string, () => RawEntry[]]>([
    ['a manifest path that climbs out of the store', () => [manifestEntry(manifest({ files: [{ role: 'transcript', path: '../../.ssh/authorized_keys', sha256: SHA, size: transcript.length, mtimeMs: 0 }] })), blobEntry]],
    ['an absolute manifest path', () => [manifestEntry(manifest({ files: [{ role: 'transcript', path: '/etc/hosts', sha256: SHA, size: transcript.length, mtimeMs: 0 }] })), blobEntry]],
    ['a blob that does not match its hash', () => [manifestEntry(), { name: `blobs/${SHA}`, body: Buffer.from(transcript).fill(0x41, 0, 1) }]],
    ['an extra entry', () => [manifestEntry(), blobEntry, { name: 'evil.sh', body: 'echo hi' }]],
    ['a blob the manifest never names', () => [manifestEntry(), blobEntry, { name: `blobs/${sha256('x')}`, body: 'x' }]],
    ['a symlink entry', () => [manifestEntry(), { name: `blobs/${SHA}`, body: '', type: '2', linkname: '/etc/passwd' }]],
    ['a directory entry', () => [manifestEntry(), { name: 'blobs/', body: '', type: '5' }, blobEntry]],
    ['a pax header', () => [{ name: 'PaxHeader', body: '30 path=../../../../etc/passwd\n', type: 'x' }, manifestEntry(), blobEntry]],
    ['an unsupported version', () => [manifestEntry(manifest({ version: 2 })), blobEntry]],
    ['a missing blob', () => [manifestEntry()]],
    ['a manifest that is not first', () => [blobEntry, manifestEntry()]],
    ['a repeated blob', () => [manifestEntry(), blobEntry, blobEntry]],
    ['a blob whose size disagrees with the manifest', () => [manifestEntry(), { name: `blobs/${SHA}`, body: Buffer.concat([transcript, Buffer.from('\n')]) }]],
    ['a manifest that is not JSON', () => [{ name: 'manifest.json', body: '{"format":' }, blobEntry]],
  ])('rejects %s and writes nothing', async (_name, entries) => {
    await writeRawArchive(file, entries())
    await expectRejected()
  })

  it('rejects an entry over the size limit', async () => {
    await writeRawArchive(file, [manifestEntry(), blobEntry])
    await expectRejected({ ...DEFAULT_LIMITS, entryBytes: 100 })
  })

  it('rejects an archive over the total size limit', async () => {
    await writeRawArchive(file, [manifestEntry(), blobEntry])
    await expectRejected({ ...DEFAULT_LIMITS, totalBytes: 1000 })
  })

  it('rejects an archive with too many entries', async () => {
    await writeRawArchive(file, [manifestEntry(), blobEntry])
    await expectRejected({ ...DEFAULT_LIMITS, entries: 1 })
  })

  it('rejects an oversized manifest', async () => {
    await writeRawArchive(file, [manifestEntry(), blobEntry])
    await expectRejected({ ...DEFAULT_LIMITS, manifestBytes: 100 })
  })

  it('rejects a truncated archive with no end marker', async () => {
    await writeRawArchive(file, [manifestEntry(), blobEntry], { endMarker: false })
    await expectRejected()
  })

  it('rejects data after the end marker', async () => {
    await writeFile(file, gzipSync(Buffer.concat([rawTar([manifestEntry(), blobEntry]), Buffer.from('trailing junk')])))
    await expectRejected()
  })

  it('rejects a file that is not gzip', async () => {
    await writeFile(file, rawTar([manifestEntry(), blobEntry]))
    await expectRejected()
  })
})

describe('import of a valid archive with hostile intent', () => {
  async function previewOf(entries: RawEntry[]) {
    await writeRawArchive(file, entries)
    const service = createSessionService(b.context)
    const opened = await service.openArchive(async () => file, () => {})
    if (!opened.ok || opened.value.kind !== 'opened') throw new Error('archive did not open')
    const mappings = [{ source: '/Users/eve/proj', target: path.join(b.home, 'proj') }]
    const preview = await service.previewImport(opened.value.token, mappings)
    const run = await service.runImport(opened.value.token, mappings, [`claude-code:${ID}`], () => {})
    return { preview, run }
  }

  it('blocks a session whose files are not laid out the way export writes them', async () => {
    const before = await treeHash(b.home)
    const { preview, run } = await previewOf([
      manifestEntry(manifest({ files: [{ role: 'transcript', path: 'history.jsonl', sha256: SHA, size: transcript.length, mtimeMs: 0 }] })),
      blobEntry,
    ])
    expect(preview).toMatchObject({ ok: true, value: { sessions: [{ action: { kind: 'blocked', reason: 'invalid-session' } }] } })
    expect(run).toMatchObject({ ok: true, value: { outcomes: [{ status: 'refused' }] } })
    expect(await treeHash(b.home)).toBe(before)
  })

  it('blocks a target folder that is a symlink out of the store', async () => {
    const outside = path.join(b.dir, 'outside')
    await mkdir(outside)
    await symlink(outside, path.join(b.root, 'projects', encodeProjectDir(path.join(b.home, 'proj'))))
    const { preview, run } = await previewOf([manifestEntry(), blobEntry])
    expect(preview).toMatchObject({ ok: true, value: { sessions: [{ action: { kind: 'blocked', reason: 'unsafe-path' } }] } })
    expect(run).toMatchObject({ ok: true, value: { outcomes: [{ status: 'refused' }] } })
    expect(await readdir(outside)).toEqual([])
  })

  it('rejects renderer input that is not a key, a mapping, or a known token', async () => {
    const service = createSessionService(b.context)
    expect(await service.previewImport('not-a-token', [])).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(await service.previewImport('0'.repeat(32), [])).toMatchObject({ ok: false, error: { code: 'unknown-archive' } })
    expect(await service.exportSessions(['claude-code:../../x'], async () => '/tmp/x', () => {})).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(await service.exportSessions([], async () => '/tmp/x', () => {})).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await writeRawArchive(file, [manifestEntry(), blobEntry])
    const opened = await service.openArchive(async () => file, () => {})
    if (!opened.ok || opened.value.kind !== 'opened') throw new Error('archive did not open')
    const token = opened.value.token
    expect(await service.previewImport(token, [{ source: '/a', target: 'relative/path' }])).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(await service.runImport(token, [], ['claude-code:4f000000-0000-4000-8000-000000000009'], () => {})).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
  })
})
