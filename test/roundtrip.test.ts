import { appendFile, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listSessions } from '../src/main/core/discovery'
import { exportSessions } from '../src/main/core/export'
import { closeArchive, defaultExists, openArchive, type OpenedArchive, previewImport, runImport, suggestMappings } from '../src/main/core/import'
import { encodeProjectDir } from '../src/main/providers/claude-code/encode'
import { sessionKey, type SessionKey } from '../src/shared/sessions'
import { readArchiveEntries } from './fixtures/archive'
import { NEVER_EXPORT, removeTempDir, treeHash, writeLiveEntry, writeNeverExportFiles, writeSession, type BuiltSession } from './fixtures/claude-store'
import { type Machine, makeMachine, shellQuoted } from './fixtures/machine'

const S1 = '2a000000-0000-4000-8000-000000000001'
const S2 = '2b000000-0000-4000-8000-000000000002'
const S3 = '2c000000-0000-4000-8000-000000000003'
const key = (id: string) => sessionKey('claude-code', id)

let a: Machine
let b: Machine
let built: Record<string, BuiltSession>
let srcProj: string
let srcLong: string

beforeEach(async () => {
  a = await makeMachine('source')
  b = await makeMachine('target')
  srcProj = path.join(a.home, 'code', 'proj')
  srcLong = path.join(a.home, ...Array.from({ length: 8 }, (_, i) => `deeply-nested-folder-number-${i}`))
  built = {
    [S1]: await writeSession(a.root, { id: S1, cwd: srcProj, subagents: true, toolResult: true }),
    [S2]: await writeSession(a.root, { id: S2, cwd: srcProj, entrypoint: 'sdk-cli', halfWrittenLastLine: true, startMinute: 50 }),
    [S3]: await writeSession(a.root, { id: S3, cwd: srcLong, startMinute: 90 }),
  }
  await writeNeverExportFiles(a.root, { id: S1, cwd: srcProj })
})
afterEach(async () => {
  await removeTempDir(a.dir)
  await removeTempDir(b.dir)
})

async function exportFrom(machine: Machine, keys: SessionKey[], name = 'out.agentsessions'): Promise<string> {
  const file = path.join(machine.dir, name)
  await exportSessions(machine.context, keys, file)
  return file
}

async function openIn(machine: Machine, archive: string): Promise<{ opened: OpenedArchive; mappings: ReturnType<typeof suggestMappings> }> {
  const opened = await openArchive(machine.context, archive)
  return { opened, mappings: suggestMappings(opened.manifest, { homeDir: machine.home, sep: path.sep, exists: defaultExists }) }
}

const records = (text: string) => text.trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, any>)

describe('export', () => {
  it('reads the source store without changing it and leaves out every never-export file', async () => {
    const before = await treeHash(a.home)
    const archive = await exportFrom(a, [key(S1), key(S2), key(S3)])
    expect(await treeHash(a.home)).toBe(before)

    const entries = await readArchiveEntries(archive)
    for (const content of entries.values()) expect(content.includes(NEVER_EXPORT)).toBe(false)
    const manifest = JSON.parse(entries.get('manifest.json')!.toString())
    const s1 = manifest.sessions.find((s: { id: string }) => s.id === S1)
    expect(s1.gitBranch).toBe('main')
    const enc = encodeProjectDir(srcProj)
    expect(s1.files.map((f: { role: string; path: string }) => `${f.role} ${f.path}`).sort()).toEqual([
      `subagent projects/${enc}/${S1}/subagents/agent-a1b2c3.jsonl`,
      `subagent projects/${enc}/${S1}/subagents/agent-a1b2c3.meta.json`,
      `tool-result projects/${enc}/${S1}/tool-results/toolu_01.txt`,
      `transcript projects/${enc}/${S1}.jsonl`,
    ])
    expect(manifest.source).toMatchObject({ homeDir: a.home, sep: path.sep, storeRoots: { 'claude-code': a.root } })
  })

  it('snapshots a half-written transcript up to its last complete line', async () => {
    const entries = await readArchiveEntries(await exportFrom(a, [key(S2)]))
    const manifest = JSON.parse(entries.get('manifest.json')!.toString())
    const transcript = manifest.sessions[0].files[0]
    const blob = entries.get(`blobs/${transcript.sha256}`)!
    expect(blob.toString()).toBe(built[S2].lines.join('\n') + '\n')
  })
})

describe('import into an empty store', () => {
  it('imports into a store root that is a symlink, as when ~/.claude lives in a dotfiles folder', async () => {
    const linked = path.join(b.dir, 'dotfiles', 'claude')
    await mkdir(linked, { recursive: true })
    await symlink(linked, b.root, 'junction')
    const { opened, mappings } = await openIn(b, await exportFrom(a, [key(S1)]))
    const result = await runImport(b.context, opened, mappings, [key(S1)])
    expect(result.outcomes.map((o) => o.status)).toEqual(['created'])
    const dstDir = path.join(linked, 'projects', encodeProjectDir(path.join(b.home, 'code', 'proj')))
    expect(await stat(path.join(dstDir, `${S1}.jsonl`)).then(() => true)).toBe(true)
  })

  it('places, rewrites, and dates each session so this machine can resume it', async () => {
    const { opened, mappings } = await openIn(b, await exportFrom(a, [key(S1), key(S2), key(S3)]))
    const dstProj = path.join(b.home, 'code', 'proj')
    const dstLong = path.join(b.home, ...Array.from({ length: 8 }, (_, i) => `deeply-nested-folder-number-${i}`))
    expect(mappings).toEqual(expect.arrayContaining([{ source: srcProj, target: dstProj }, { source: srcLong, target: dstLong }]))
    expect(opened.manifest.sessions.map((s) => s.gitBranch)).toEqual(['main', 'main', 'main'])

    const preview = await previewImport(b.context, opened, mappings)
    expect(preview.sessions.map((s) => [s.key, s.action.kind])).toEqual([[key(S1), 'create'], [key(S2), 'create'], [key(S3), 'create']])
    expect(preview.sessions[1].warnings).toContainEqual({ code: 'hidden-from-picker', clientDetail: 'sdk-cli' })
    expect(preview.sessions[0].warnings).toContainEqual({ code: 'target-cwd-missing', path: dstProj })

    const result = await runImport(b.context, opened, mappings, [key(S1), key(S2), key(S3)])
    expect(result.outcomes.map((o) => o.status)).toEqual(['created', 'created', 'created'])
    expect(result.outcomes[0], 'the result carries the resume command for the folder it landed in').toMatchObject({ resumeCommand: `cd ${shellQuoted(dstProj)} && claude --resume ${S1}` })

    const dstDir = path.join(b.root, 'projects', encodeProjectDir(dstProj))
    const imported = await readFile(path.join(dstDir, `${S1}.jsonl`), 'utf8')
    const source = built[S1].lines
    const lines = imported.trimEnd().split('\n')
    expect(lines).toHaveLength(source.length)
    for (const [i, record] of records(imported).entries()) {
      const original = JSON.parse(source[i])
      if (typeof original.cwd === 'string') expect(record.cwd).toBe(dstProj)
      if (original.attachment?.snapshot) expect(record.attachment.snapshot.workingDirectory).toBe(dstProj)
      if (original.toolUseResult?.persistedOutputPath) {
        expect(record.toolUseResult.persistedOutputPath).toBe(path.join(dstDir, S1, 'tool-results', 'toolu_01.txt'))
      }
      // Free text, tool inputs, and other path fields stay as history.
      expect(record.message).toEqual(original.message)
      if (original.toolUseResult) expect(record.toolUseResult.filePath).toBe(original.toolUseResult.filePath)
      if (original.attachment?.snapshot) expect(record.attachment.snapshot.scratchpadDirectory).toBe(original.attachment.snapshot.scratchpadDirectory)
      if (typeof original.cwd !== 'string') expect(lines[i]).toBe(source[i])
    }

    expect((await stat(path.join(dstDir, `${S1}.jsonl`))).mtimeMs).toBe(Date.parse(built[S1].lastTimestamp))
    expect(await readFile(path.join(dstDir, S1, 'tool-results', 'toolu_01.txt'))).toEqual(await readFile(built[S1].toolResultPath!))
    expect(await readFile(path.join(dstDir, S1, 'subagents', 'agent-a1b2c3.meta.json'))).toEqual(
      await readFile(path.join(built[S1].dir, S1, 'subagents', 'agent-a1b2c3.meta.json')),
    )
    expect(records(await readFile(path.join(dstDir, S1, 'subagents', 'agent-a1b2c3.jsonl'), 'utf8'))[0].cwd).toBe(dstProj)

    expect(records(await readFile(path.join(dstDir, `${S2}.jsonl`), 'utf8'))).toHaveLength(built[S2].lines.length)
    const longDir = path.join(b.root, 'projects', encodeProjectDir(dstLong))
    expect(await stat(path.join(longDir, `${S3}.jsonl`)).then(() => true)).toBe(true)
    expect(encodeProjectDir(dstLong).length).toBeGreaterThan(200)

    const listed = await listSessions(b.context)
    expect(listed.sessions.find((s) => s.id === S1)).toMatchObject({ cwd: dstProj, resumeCommand: `cd ${shellQuoted(dstProj)} && claude --resume ${S1}` })
    await closeArchive(opened)
  })

  it('is idempotent: a second run skips every session and changes nothing', async () => {
    const { opened, mappings } = await openIn(b, await exportFrom(a, [key(S1), key(S2)]))
    await runImport(b.context, opened, mappings, [key(S1), key(S2)])
    const after = await treeHash(b.root)
    const again = await runImport(b.context, opened, mappings, [key(S1), key(S2)])
    expect(again.outcomes.map((o) => o.status)).toEqual(['skipped', 'skipped'])
    expect(await treeHash(b.root)).toBe(after)
  })

  it('round-trips byte for byte when the paths map to themselves', async () => {
    const { opened } = await openIn(b, await exportFrom(a, [key(S1)]))
    const identity = [{ source: srcProj, target: srcProj }]
    const preview = await previewImport(a.context, opened, identity)
    expect(preview.sessions[0].action).toEqual({ kind: 'skip-identical' })
  })
})

describe('import into a populated store', () => {
  async function importOnce(): Promise<{ archive: string; mappings: ReturnType<typeof suggestMappings>; dstFile: string }> {
    const archive = await exportFrom(a, [key(S1)], 'first.agentsessions')
    const { opened, mappings } = await openIn(b, archive)
    expect((await runImport(b.context, opened, mappings, [key(S1)])).backupDir, 'a run that only creates keeps no backups').toBeNull()
    const dstFile = path.join(b.root, 'projects', encodeProjectDir(path.join(b.home, 'code', 'proj')), `${S1}.jsonl`)
    return { archive, mappings, dstFile }
  }

  it('updates a strict prefix and keeps the old copy as a backup', async () => {
    const { mappings, dstFile } = await importOnce()
    const old = await readFile(dstFile)
    await appendFile(built[S1].transcriptPath, JSON.stringify({ type: 'user', cwd: srcProj, sessionId: S1, timestamp: '2026-11-02T09:00:00.000Z', message: { role: 'user', content: 'more' } }) + '\n')

    const { opened } = await openIn(b, await exportFrom(a, [key(S1)], 'second.agentsessions'))
    expect((await previewImport(b.context, opened, mappings)).sessions[0].action).toEqual({ kind: 'update', backup: true })
    const result = await runImport(b.context, opened, mappings, [key(S1)])
    const [outcome] = result.outcomes
    expect(outcome.status).toBe('updated')
    expect(result.backupDir, 'the run names its backup folder').toBe(path.dirname((outcome as { backupDir: string }).backupDir))
    const updated = await readFile(dstFile)
    expect(updated.subarray(0, old.length)).toEqual(old)
    expect(records(updated.toString()).at(-1)).toMatchObject({ cwd: path.join(b.home, 'code', 'proj'), timestamp: '2026-11-02T09:00:00.000Z' })
    expect(outcome.status === 'updated' && outcome.backupDir).toBeTruthy()
    const rel = path.relative(b.root, dstFile)
    expect(await readFile(path.join((outcome as { backupDir: string }).backupDir, rel))).toEqual(old)
    expect((await stat(dstFile)).mtimeMs).toBe(Date.parse('2026-11-02T09:00:00.000Z'))
  })

  it('refuses a diverged copy and leaves the store untouched', async () => {
    const { archive, mappings, dstFile } = await importOnce()
    await writeFile(dstFile, (await readFile(dstFile, 'utf8')).replace('Tokenizer test', 'Tokenizer tesT'))
    const before = await treeHash(b.root)
    const { opened } = await openIn(b, archive)
    const [outcome] = (await runImport(b.context, opened, mappings, [key(S1)])).outcomes
    expect(outcome).toMatchObject({ status: 'refused', action: { kind: 'conflict', reason: 'diverged' } })
    expect(await treeHash(b.root)).toBe(before)
  })

  it('refuses when the copy here already continues past the archive', async () => {
    const { archive, mappings, dstFile } = await importOnce()
    await appendFile(dstFile, JSON.stringify({ type: 'user', sessionId: S1, timestamp: '2026-11-03T00:00:00.000Z' }) + '\n')
    const { opened } = await openIn(b, archive)
    expect((await previewImport(b.context, opened, mappings)).sessions[0].action).toMatchObject({ kind: 'conflict', reason: 'target-newer' })
  })

  it('blocks a session that is live on this machine', async () => {
    const { archive, mappings, dstFile } = await importOnce()
    const content = await readFile(dstFile)
    await writeFile(dstFile, content.subarray(0, content.indexOf('\n') + 1))
    await writeLiveEntry(b.root, process.pid, S1)
    const before = await treeHash(b.root)
    const { opened } = await openIn(b, archive)
    const [outcome] = (await runImport(b.context, opened, mappings, [key(S1)])).outcomes
    expect(outcome).toMatchObject({ status: 'refused', action: { kind: 'blocked', reason: 'live' } })
    expect(await treeHash(b.root)).toBe(before)
  })

  it('refuses when the store already holds the session in two project folders', async () => {
    const { archive, mappings, dstFile } = await importOnce()
    const elsewhere = path.join(b.root, 'projects', '-elsewhere')
    await writeSession(b.root, { id: S1, cwd: '/elsewhere' })
    expect(elsewhere).not.toBe(path.dirname(dstFile))
    const { opened } = await openIn(b, archive)
    expect((await previewImport(b.context, opened, mappings)).sessions[0].action).toMatchObject({ kind: 'conflict', reason: 'multiple-copies' })
  })

  it('matches the session id in any project folder and never creates a second copy', async () => {
    const { mappings, dstFile } = await importOnce()
    await appendFile(built[S1].transcriptPath, JSON.stringify({ type: 'system', sessionId: S1, timestamp: '2026-11-04T00:00:00.000Z' }) + '\n')
    const { opened } = await openIn(b, await exportFrom(a, [key(S1)], 'second.agentsessions'))
    const moved = mappings.map((m) => (m.source === srcProj ? { ...m, target: path.join(b.home, 'moved') } : m))
    const [outcome] = (await runImport(b.context, opened, moved, [key(S1)])).outcomes
    expect(outcome).toMatchObject({ status: 'refused', action: { kind: 'conflict', reason: 'diverged' } })
    expect(await stat(path.join(b.root, 'projects', encodeProjectDir(path.join(b.home, 'moved')))).catch(() => null)).toBeNull()
    expect(await stat(dstFile).then(() => true)).toBe(true)
  })
})
