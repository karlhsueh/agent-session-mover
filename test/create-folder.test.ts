import { existsSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exportSessions } from '../src/main/core/export'
import { createSessionService, type SessionService } from '../src/main/service'
import { sessionKey } from '../src/shared/sessions'
import { removeTempDir, writeSession } from './fixtures/claude-store'
import { type Machine, makeMachine } from './fixtures/machine'

const ID = '7b000000-0000-4000-8000-0000000000c1'
let a: Machine
let service: SessionService

beforeEach(async () => {
  a = await makeMachine('create-folder')
  await writeSession(a.root, { id: ID, cwd: path.join(a.home, 'proj') })
  service = createSessionService(a.context)
})
afterEach(async () => {
  await service.dispose()
  await chmod(path.join(a.dir, 'locked'), 0o755).catch(() => undefined)
  await removeTempDir(a.dir)
})

async function openToken(): Promise<string> {
  const file = path.join(a.dir, 'out.agentsessions')
  await exportSessions(a.context, [sessionKey('claude-code', ID)], file)
  const opened = await service.openArchive(async () => file, () => {})
  if (!opened.ok || opened.value.kind !== 'opened') throw new Error('archive did not open')
  return opened.value.token
}

describe('createFolder', () => {
  it('creates a missing folder and its missing parents', async () => {
    const token = await openToken()
    const target = path.join(a.dir, 'new', 'deeper', 'proj')
    expect(await service.createFolder(token, target)).toEqual({ ok: true, value: undefined })
    expect((await stat(target)).isDirectory()).toBe(true)
  })

  it('leaves an existing folder and its content as they are', async () => {
    const token = await openToken()
    const target = path.join(a.dir, 'existing')
    await mkdir(target)
    await writeFile(path.join(target, 'keep.txt'), 'kept')
    const before = await stat(path.join(target, 'keep.txt'))
    expect(await service.createFolder(token, target)).toEqual({ ok: true, value: undefined })
    expect(await readdir(target)).toEqual(['keep.txt'])
    expect(await readFile(path.join(target, 'keep.txt'), 'utf8')).toBe('kept')
    expect((await stat(path.join(target, 'keep.txt'))).mtimeMs).toBe(before.mtimeMs)
  })

  it('rejects input that is not an absolute path, and creates nothing', async () => {
    const token = await openToken()
    for (const bad of ['relative/proj', '', 42, null, ['/tmp/x'], `${a.dir}/nul\0x`, `/${'x'.repeat(5000)}`]) {
      expect(await service.createFolder(token, bad)).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    }
    expect(existsSync(path.join(process.cwd(), 'relative'))).toBe(false)
  })

  it('works only for the open archive', async () => {
    const target = path.join(a.dir, 'not-made')
    expect(await service.createFolder('0'.repeat(32), target)).toMatchObject({ ok: false, error: { code: 'unknown-archive' } })
    expect(await service.createFolder('not-a-token', target)).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(existsSync(target)).toBe(false)
  })

  it('says when a file is in the way, and leaves the file alone', async () => {
    const token = await openToken()
    const file = path.join(a.dir, 'a-file')
    await writeFile(file, 'data')
    for (const target of [file, path.join(file, 'child')]) {
      expect(await service.createFolder(token, target)).toEqual({ ok: false, error: { code: 'io', message: 'Part of this path is a file, not a folder.' } })
    }
    expect(await readFile(file, 'utf8')).toBe('data')
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('says when permission is denied', async () => {
    const token = await openToken()
    const locked = path.join(a.dir, 'locked')
    await mkdir(locked)
    await chmod(locked, 0o555)
    const target = path.join(locked, 'proj')
    expect(await service.createFolder(token, target)).toEqual({ ok: false, error: { code: 'io', message: 'No permission to create a folder here.' } })
    expect(existsSync(target)).toBe(false)
  })
})
