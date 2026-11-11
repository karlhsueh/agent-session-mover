import { describe, expect, it } from 'vitest'
import { copyLines, hereIsAhead, outcomeBadge, planBadge, planRank, receivesFiles, selectedForImport, verdict, warningText } from '../src/renderer/src/model/importing'
import { type ConflictChoice, type ImportAction, type ImportPreview, sessionKey, type SessionKey } from '../src/shared/sessions'

const key = (n: number) => sessionKey('claude-code', `5a000000-0000-4000-8000-00000000000${n}`)
const conflict: ImportAction = { kind: 'conflict', reason: 'diverged', message: 'm', copies: null }
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

describe('judging a conflict', () => {
  const facts = (lastMessageAt: string | null, messages: number) => ({ lastMessageAt, messages, complete: true })
  const withCopies = (here: ReturnType<typeof facts>, archive: ReturnType<typeof facts>): ImportAction => ({ ...conflict, copies: { here, archive } }) as ImportAction

  it('warns before replacing a copy here that is newer or goes further', () => {
    const newerHere = withCopies(facts('2026-11-10T12:00:00.000Z', 10), facts('2026-11-09T12:00:00.000Z', 12))
    expect(hereIsAhead(newerHere), 'the last message decides before the count').toBe(true)
    expect(planBadge(newerHere, 'replace')).toEqual({ label: 'Replace', tone: 'warn' })
    expect(planBadge(withCopies(facts('2026-11-08T12:00:00.000Z', 10), facts('2026-11-09T12:00:00.000Z', 8)), 'replace').tone).toBe('info')
    expect(hereIsAhead(withCopies(facts(null, 9), facts(null, 8))), 'without times the longer copy is ahead').toBe(true)
    expect(hereIsAhead({ ...conflict, reason: 'target-newer' }), 'a copy that continues past the archive is ahead').toBe(true)
    expect(hereIsAhead(conflict)).toBe(false)
  })

  it('describes both copies in the same terms and marks the newer one', () => {
    const action = withCopies(facts('2026-11-10T12:00:00.000Z', 13), { lastMessageAt: null, messages: 12, complete: false }) as Extract<ImportAction, { kind: 'conflict' }>
    const [here, archive] = copyLines(action)
    expect(here).toMatchObject({ label: "This computer's copy", newer: true })
    expect(here!.text).toMatch(/^13 messages · last Nov 10/)
    expect(archive).toEqual({ label: "Archive's copy", text: 'At least 12 messages', newer: false })
    expect(copyLines(conflict as Extract<ImportAction, { kind: 'conflict' }>)).toEqual([])
  })
})

describe('the import verdict', () => {
  it('counts each session by what import will do, naming only the parts that have sessions', () => {
    const choices = new Map<SessionKey, ConflictChoice>([[key(4), 'replace']])
    expect(verdict(preview, new Set(), choices).map((part) => part.text)).toEqual(['1 will be added', '1 will be updated', '1 will be replaced', '1 needs a decision', '1 already here', '1 blocked'])
    choices.set(key(3), 'skip')
    expect(verdict(preview, new Set([key(1)]), choices).map((part) => part.kind)).toEqual(['update', 'replace', 'keep', 'identical', 'blocked', 'left-out'])
  })

  it('lists conflicts first and identical sessions last', () => {
    const ranked = [...preview.sessions].sort((a, b) => planRank(a.action) - planRank(b.action)).map((session) => session.action.kind)
    expect(ranked).toEqual(['conflict', 'conflict', 'create', 'update', 'blocked', 'skip-identical'])
  })

  it('asks for a folder only where import may write', () => {
    expect(receivesFiles({ kind: 'create' }, 'skip')).toBe(true)
    expect(receivesFiles(conflict, 'skip')).toBe(false)
    expect(receivesFiles(conflict, 'replace')).toBe(true)
    expect(receivesFiles({ kind: 'skip-identical' }, 'replace')).toBe(false)
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
