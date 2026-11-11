import { describe, expect, it } from 'vitest'
import { outcomeBadge, planBadge, selectedForImport, warningText } from '../src/renderer/src/model/importing'
import { type ConflictChoice, type ImportAction, type ImportPreview, sessionKey, type SessionKey } from '../src/shared/sessions'

const key = (n: number) => sessionKey('claude-code', `5a000000-0000-4000-8000-00000000000${n}`)
const conflict: ImportAction = { kind: 'conflict', reason: 'diverged', message: 'm', hereChangedAt: null }
const preview: ImportPreview = {
  sessions: (
    [
      [1, { kind: 'create' }],
      [2, { kind: 'update', backup: true }],
      [3, conflict],
      [4, conflict],
      [5, { kind: 'skip-identical' }],
      [6, { kind: 'blocked', reason: 'live', message: 'm' }],
    ] as const
  ).map(([n, action]) => ({ key: key(n), action, targetCwd: null, warnings: [] })),
}

describe('what the import screen sends', () => {
  it('imports ticked creates and updates, and replaces only the conflicts the user chose to replace', () => {
    const choices = new Map<SessionKey, ConflictChoice>([[key(4), 'replace']])
    expect(selectedForImport(preview, new Set([key(2)]), choices)).toEqual([
      { key: key(1), onConflict: 'skip' },
      { key: key(4), onConflict: 'replace' },
    ])
  })

  it('skips every conflict by default', () => {
    expect(selectedForImport(preview, new Set(), new Map()).map((request) => request.key)).toEqual([key(1), key(2)])
  })

  it('labels a conflict by the choice made for it', () => {
    expect(planBadge(conflict, 'skip')).toMatchObject({ label: 'Conflict' })
    expect(planBadge(conflict, 'replace')).toMatchObject({ label: 'Replace' })
    expect(planBadge({ kind: 'create' }, 'replace').label).not.toBe('Replace')
  })
})

describe('import screen wording', () => {
  it('names each result with the verb its plan used', () => {
    const base = { key: key(1), backupDir: null, resumeCommand: 'x' }
    expect(planBadge({ kind: 'create' }, 'skip').label).toBe('Add')
    expect(outcomeBadge({ ...base, status: 'created', action: { kind: 'create' } }).label).toBe('Added')
    expect(planBadge({ kind: 'update', backup: true }, 'skip').label).toBe('Update')
    expect(outcomeBadge({ ...base, status: 'updated', action: { kind: 'update', backup: true } }).label).toBe('Updated')
    expect(outcomeBadge({ ...base, status: 'replaced', action: conflict }).label).toBe('Replaced')
    expect(outcomeBadge({ key: key(1), status: 'refused', action: conflict }).label).toBe('Kept')
  })

  it('shows a missing folder under ~, and points at Folders when that section lists it', () => {
    const warning = { code: 'target-cwd-missing', path: '/Users/me/code/api/sub' } as const
    expect(warningText(warning, 'claude-code', '/Users/me', false)).toMatch(/^~\/code\/api\/sub does not exist yet\./)
    expect(warningText(warning, 'claude-code', '/Users/me', true)).toBe('Its folder does not exist yet. See Folders above.')
  })
})
