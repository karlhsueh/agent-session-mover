import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findSidecars, findTranscripts } from '../src/main/providers/claude-code/store'
import { makeTempDir, removeTempDir, writeSession } from './fixtures/claude-store'

const vanished = new Set<string>()
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  const gone = (target: string) => Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' })
  return { ...fs, lstat: (target: string, ...rest: []) => (vanished.has(path.basename(target)) ? Promise.reject(gone(target)) : fs.lstat(target, ...rest)) }
})

const KEEP = '3a000000-0000-4000-8000-000000000001'
const GONE = '3b000000-0000-4000-8000-000000000002'
let dir: string
afterEach(async () => {
  vanished.clear()
  await removeTempDir(dir)
})

describe('a file that vanishes between readdir and lstat', () => {
  it('is skipped, and the rest of the store still lists', async () => {
    dir = await makeTempDir('vanishing')
    const root = path.join(dir, '.claude')
    await writeSession(root, { id: KEEP, cwd: path.join(dir, 'a'), toolResult: true })
    await writeSession(root, { id: GONE, cwd: path.join(dir, 'b') })
    vanished.add(`${GONE}.jsonl`).add('toolu_01.txt')
    const found = await findTranscripts(root)
    expect(found.map((t) => t.id)).toEqual([KEEP])
    expect(await findSidecars(found[0]!)).toEqual([])
  })
})
