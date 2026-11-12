import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeProjectDir } from '../src/main/providers/claude-code/encode'
import { createSessionService } from '../src/main/service'
import { type PathMapping, requestsFor, sessionKey } from '../src/shared/sessions'
import { sha256, writeRawArchive } from './fixtures/archive'
import { removeTempDir, transcriptRecords } from './fixtures/claude-store'
import { type Machine, makeMachine } from './fixtures/machine'

// Every CI runner imports an archive made on the other kind of system: Windows-made on macOS and Linux, macOS-made on Windows.
const windowsMade = path.sep === '/'
const source = windowsMade
  ? { platform: 'win32', homeDir: 'C:\\Users\\eve', sep: '\\', inHome: 'C:\\Users\\eve\\code\\api', outside: 'D:\\work\\tools' }
  : { platform: 'darwin', homeDir: '/Users/eve', sep: '/', inHome: '/Users/eve/code/api', outside: '/opt/tools' }
const storeRoot = [source.homeDir, '.claude'].join(source.sep)
const IN_HOME = '4c000000-0000-4000-8000-000000000001'
const OUTSIDE = '4c000000-0000-4000-8000-000000000002'

let b: Machine
let file: string

beforeEach(async () => {
  b = await makeMachine('cross-os')
  file = path.join(b.dir, 'in.agentsessions')
  await mkdir(path.join(b.root, 'projects'), { recursive: true })
  const sessions = [
    { id: IN_HOME, cwd: source.inHome },
    { id: OUTSIDE, cwd: source.outside },
  ].map(({ id, cwd }) => {
    const body = Buffer.from(transcriptRecords(storeRoot, { id, cwd }).lines.join('\n') + '\n')
    const entry = {
      agent: 'claude-code',
      id,
      title: 't',
      client: 'cli',
      clientDetail: 'cli',
      cwd,
      cwds: [cwd],
      createdAt: '2026-11-01T10:00:00.000Z',
      lastActivity: '2026-11-01T11:00:00.000Z',
      cliVersion: '2.1.319',
      files: [{ role: 'transcript', path: `projects/${encodeProjectDir(cwd)}/${id}.jsonl`, sha256: sha256(body), size: body.length, mtimeMs: 0 }],
    }
    return { entry, body }
  })
  const manifest = {
    format: 'agent-sessions-archive',
    version: 1,
    createdAt: '2026-11-07T10:00:00.000Z',
    appVersion: '0.0.0',
    source: { platform: source.platform, homeDir: source.homeDir, sep: source.sep, storeRoots: { 'claude-code': storeRoot } },
    sessions: sessions.map(({ entry }) => entry),
  }
  await writeRawArchive(file, [
    { name: 'manifest.json', body: JSON.stringify(manifest) },
    ...sessions.map(({ body }) => ({ name: `blobs/${sha256(body)}`, body })),
  ])
})
afterEach(async () => removeTempDir(b.dir))

async function cwdsIn(id: string, cwd: string): Promise<string[]> {
  const text = await readFile(path.join(b.root, 'projects', encodeProjectDir(cwd), `${id}.jsonl`), 'utf8')
  return [...new Set(text.trim().split('\n').flatMap((line) => (JSON.parse(line) as { cwd?: string }).cwd ?? []))]
}

describe(`importing an archive made on ${windowsMade ? 'Windows' : 'macOS'}`, () => {
  it('places a session under the home folder and asks for a folder outside it', async () => {
    const service = createSessionService(b.context)
    const opened = await service.openArchive(async () => file, () => {})
    if (!opened.ok || opened.value.kind !== 'opened') throw new Error('archive did not open')
    const { token, suggestedMappings } = opened.value
    const inHome = path.join(b.home, 'code', 'api')
    expect(suggestedMappings).toEqual([
      { source: source.outside, target: '' },
      { source: source.inHome, target: inHome },
    ])

    const preview = await service.previewImport(token, suggestedMappings)
    expect(preview.ok && preview.value.sessions.map((session) => [session.key, session.action.kind, session.targetCwd])).toEqual([
      [sessionKey('claude-code', IN_HOME), 'create', inHome],
      [sessionKey('claude-code', OUTSIDE), 'blocked', null],
    ])

    const keys = [sessionKey('claude-code', IN_HOME), sessionKey('claude-code', OUTSIDE)]
    const first = await service.runImport(token, suggestedMappings, requestsFor(keys), () => {})
    expect(first.ok && first.value.outcomes.map((outcome) => outcome.status)).toEqual(['created', 'refused'])
    expect(await cwdsIn(IN_HOME, inHome)).toEqual([inHome])

    const tools = path.join(b.dir, 'tools')
    const chosen: PathMapping[] = suggestedMappings.map((mapping) => (mapping.source === source.outside ? { ...mapping, target: tools } : mapping))
    const second = await service.runImport(token, chosen, requestsFor([sessionKey('claude-code', OUTSIDE)]), () => {})
    expect(second.ok && second.value.outcomes.map((outcome) => outcome.status)).toEqual(['created'])
    expect(await cwdsIn(OUTSIDE, tools)).toEqual([tools])
  })
})
