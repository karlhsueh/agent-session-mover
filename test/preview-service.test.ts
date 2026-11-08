import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exportSessions } from '../src/main/core/export'
import { createSessionService, type SessionService } from '../src/main/service'
import { type SessionKey, sessionKey } from '../src/shared/sessions'
import { removeTempDir, writeSession } from './fixtures/claude-store'
import { buildCodexStore, CX } from './fixtures/codex-store'
import { type Machine, makeMachine } from './fixtures/machine'

const CLAUDE_ID = '7b000000-0000-4000-8000-000000000001'
const claudeKey = sessionKey('claude-code', CLAUDE_ID)
const codexKey = sessionKey('codex', CX.compressed)
let a: Machine
let service: SessionService

beforeEach(async () => {
  a = await makeMachine('preview-service')
  const cwd = path.join(a.home, 'proj')
  await writeSession(a.root, { id: CLAUDE_ID, cwd })
  await buildCodexStore(a.codexRoot, cwd)
  service = createSessionService(a.context)
})
afterEach(async () => {
  await service.dispose()
  await removeTempDir(a.dir)
})

async function openExport(keys: SessionKey[]) {
  const file = path.join(a.dir, 'out.agentsessions')
  await exportSessions(a.context, keys, file)
  const opened = await service.openArchive(async () => file, () => {})
  if (!opened.ok || opened.value.kind !== 'opened') throw new Error('archive did not open')
  return opened.value.token
}

describe('preview calls', () => {
  it('previews a stored session of each agent, including a compressed Codex rollout', async () => {
    expect(await service.previewSession(claudeKey)).toMatchObject({ ok: true, value: { kind: 'ok', first: { kind: 'user', text: 'Add a unit test for the tokenizer' } } })
    expect(await service.previewSession(codexKey)).toMatchObject({ ok: true, value: { kind: 'ok', first: { kind: 'user', text: 'Run the exec job' } } })
  })

  it('previews an archived session from its staged blob, the same as the stored copy', async () => {
    const token = await openExport([claudeKey, codexKey])
    for (const key of [claudeKey, codexKey]) {
      const archived = await service.previewArchiveSession(token, key)
      expect(archived.ok && archived.value.kind).toBe('ok')
      expect(archived).toEqual(await service.previewSession(key))
    }
  })

  it('says a session that left this machine is unavailable', async () => {
    expect(await service.previewSession(sessionKey('claude-code', '7b000000-0000-4000-8000-0000000000ff'))).toEqual({
      ok: true,
      value: { kind: 'unavailable', reason: 'This session is no longer on this machine.' },
    })
  })

  it('rejects malformed keys and tokens and sessions the archive does not hold', async () => {
    for (const bad of ['claude-code:../../etc/passwd', 'nope:abc', 42, null, { key: claudeKey }]) {
      expect(await service.previewSession(bad)).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    }
    const token = await openExport([claudeKey])
    expect(await service.previewArchiveSession('not-a-token', claudeKey)).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(await service.previewArchiveSession('0'.repeat(32), claudeKey)).toMatchObject({ ok: false, error: { code: 'unknown-archive' } })
    expect(await service.previewArchiveSession(token, '../x')).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(await service.previewArchiveSession(token, codexKey)).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
  })

  it('runs while an export holds the lock', async () => {
    let release = () => {}
    const held = new Promise<string | null>((resolve) => (release = () => resolve(null)))
    const exporting = service.exportSessions([claudeKey], () => held, () => {})
    expect(await service.previewImport('0'.repeat(32), []), 'the lock is held').toMatchObject({ ok: false, error: { code: 'busy' } })
    expect(await service.previewSession(claudeKey)).toMatchObject({ ok: true, value: { kind: 'ok' } })
    release()
    expect(await exporting).toEqual({ ok: true, value: { kind: 'cancelled' } })
  })
})
