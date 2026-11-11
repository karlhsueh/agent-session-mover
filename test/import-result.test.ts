import { describe, expect, it } from 'vitest'
import { missingFolderHint } from '../src/renderer/src/model/importing'
import { accountFor, quietSummary } from '../src/renderer/src/model/result'
import { type ImportAction, type ImportPreview, type ImportResult, type SessionInfo, sessionKey } from '../src/shared/sessions'

const key = (n: number) => sessionKey('claude-code', `5a000000-0000-4000-8000-00000000000${n}`)
const conflict: ImportAction = { kind: 'conflict', reason: 'diverged', message: 'm', copies: null }

function info(n: number, branch: string): SessionInfo {
  return {
    key: key(n), agent: 'claude-code', id: `5a000000-0000-4000-8000-00000000000${n}`, client: 'cli', clientDetail: 'cli', title: `Session ${n}`,
    cwd: null, cwds: [], createdAt: '2026-11-01T00:00:00.000Z', lastActivity: `2026-11-0${n}T00:00:00.000Z`, cliVersion: null, gitBranch: branch, sizeBytes: 1, fileCount: 1,
  }
}

const folders: Record<number, string> = { 1: '/Users/me/code/web', 2: '/Users/me/code/api', 3: '/Users/me/code/api', 4: '/Users/me/code/web', 5: '/Users/me/code/web', 6: '/Users/me/code/api' }
const actions: Record<number, ImportAction> = {
  1: { kind: 'create' },
  2: { kind: 'update', backup: true },
  3: conflict,
  4: { kind: 'skip-identical' },
  5: { kind: 'blocked', reason: 'live', message: 'Quit it first.' },
  6: { kind: 'create' },
}
const plan: ImportPreview = {
  sessions: [1, 2, 3, 4, 5, 6].map((n) => ({
    key: key(n),
    action: actions[n]!,
    targetCwd: folders[n]!,
    warnings: n === 1 ? [{ code: 'target-cwd-missing', path: '/Users/me/code/web' }] : [],
  })),
}
const result: ImportResult = {
  runId: 'r',
  backupDir: '/Users/me/backups/r',
  outcomes: [
    { key: key(1), status: 'created', action: { kind: 'create' }, backupDir: null, resumeCommand: "cd '/Users/me/code/web' && claude --resume a" },
    { key: key(2), status: 'updated', action: { kind: 'update', backup: true }, backupDir: '/b', resumeCommand: "cd '/Users/me/code/api' && claude --resume b" },
  ],
}

describe('the import result', () => {
  const account = accountFor([1, 2, 3, 4, 5, 6].map((n) => info(n, n === 1 ? 'feature/x' : 'main')), result, plan, '/Users/me')

  it('groups written sessions by folder, a missing folder first, with its branches', () => {
    expect(account.groups.map((group) => [group.folder, group.missing, group.branches])).toEqual([
      ['/Users/me/code/web', true, ['feature/x']],
      ['/Users/me/code/api', false, ['main']],
    ])
    expect(account.groups[0]!.entries[0]).toMatchObject({ badge: { label: 'Added' }, resume: "cd ~/'code/web' && claude --resume a" })
    expect(account.placed).toBe(2)
  })

  it('keeps every other session of the archive in the record', () => {
    expect(account.quiet.map((entry) => [entry.key, entry.kind])).toEqual([
      [key(6), 'left-out'],
      [key(5), 'blocked'],
      [key(4), 'identical'],
      [key(3), 'kept'],
    ])
    expect(quietSummary(account.quiet)).toBe('1 already on this computer · 1 kept the copy here · 1 blocked · 1 left out')
  })

  it('hints at the branch to check out in a folder that does not exist yet', () => {
    expect(missingFolderHint(['main'])).toEqual({ text: 'Clone the repo here, then run', command: 'git checkout main' })
    expect(missingFolderHint(['a', 'b', 'c']).text).toBe('Clone the repo here, then check out a, b or c.')
    expect(missingFolderHint([]).command).toBeNull()
  })
})
