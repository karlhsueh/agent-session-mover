import { describe, expect, it } from 'vitest'
import { planBadge, selectedForImport } from '../src/renderer/src/model/importing'
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
