import { describe, expect, it } from 'vitest'
import { copyLines, hereIsAhead, outcomeBadge, planBadge, planRank, receivesFiles, runSummary, selectedForImport, verdict, warningText } from '../src/renderer/src/model/importing'
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

  it('labels a conflict by what import will do with it', () => {
    expect(planBadge(conflict, 'skip')).toMatchObject({ label: 'Keep', tone: 'neutral' })
    expect(planBadge(conflict, 'replace')).toEqual({ label: 'Replace', tone: 'info' })
    expect(planBadge({ kind: 'create' }, 'replace').label).not.toBe('Replace')
  })

  it('names what the start button does, and mentions backups only when something is replaced', () => {
    const choices = new Map<SessionKey, ConflictChoice>([[key(4), 'replace']])
    expect(runSummary(preview, selectedForImport(preview, new Set([key(2)]), new Map()))).toEqual({ label: 'Import 1 session', backups: null })
    expect(runSummary(preview, selectedForImport(preview, new Set(), new Map()))).toMatchObject({ label: 'Import 2 sessions', backups: 'Update keeps a backup of the copy it replaces.' })
    expect(runSummary(preview, selectedForImport(preview, new Set([key(1), key(2)]), choices))).toMatchObject({ label: 'Replace 1 session', backups: 'Replace keeps a backup of the copy it replaces.' })
    expect(runSummary(preview, selectedForImport(preview, new Set(), choices))).toMatchObject({ label: 'Import 2 · replace 1', backups: 'Update and Replace keep a backup of the copy they replace.' })
    expect(runSummary(preview, []).label).toBe('Nothing to import')
  })
})

describe('judging a conflict', () => {
  const facts = (lastMessageAt: string | null, messages: number, lines = messages * 2) => ({ lastMessageAt, messages, lines, complete: true })
  type Facts = ReturnType<typeof facts> | { lastMessageAt: string | null; messages: number; lines: number; complete: boolean }
  const withCopies = (here: Facts, archive: Facts) => ({ ...conflict, copies: { here, archive } }) as Extract<ImportAction, { kind: 'conflict' }>
  const at = (day: number) => `2026-11-${String(day).padStart(2, '0')}T12:00:00.000Z`

  it('warns before replacing only when the copy here has newer or more messages', () => {
    expect(hereIsAhead(withCopies(facts(at(10), 10), facts(at(9), 12))), 'a later last message').toBe(true)
    expect(hereIsAhead(withCopies(facts(null, 9), facts(null, 8))), 'more messages').toBe(true)
    expect(hereIsAhead(withCopies(facts(at(8), 10), facts(at(9), 12))), 'the archive has the later and more messages').toBe(false)
    const extraLines = { ...withCopies(facts(at(9), 10, 30), facts(at(9), 10, 20)), reason: 'target-newer' as const }
    expect(hereIsAhead(extraLines), 'extra lines that are not messages').toBe(false)
    expect(hereIsAhead({ ...conflict, reason: 'target-newer' }), 'unread copies that continue past the archive').toBe(true)
    expect(hereIsAhead(conflict)).toBe(false)
    expect(planBadge(withCopies(facts(at(10), 10), facts(at(9), 12)), 'replace').tone, 'the badge keeps its tone').toBe('info')
  })

  it('says what each copy has over the other, and calls one newer only when its last message is later', () => {
    const [here, archive] = copyLines(withCopies(facts(at(10), 13), facts(at(9), 12)))
    expect(here).toMatchObject({ label: "This computer's copy", more: '1 more message', newer: true })
    expect(here!.text).toMatch(/^13 messages · last Nov 10/)
    expect(archive).toMatchObject({ label: "Archive's copy", more: null, newer: false })

    const [sameHere, sameArchive] = copyLines(withCopies(facts(at(9), 12, 40), facts(at(9), 12, 37)))
    expect(sameHere).toMatchObject({ more: 'same messages, 3 more lines', newer: false })
    expect(sameArchive).toMatchObject({ more: null, newer: false })

    const [partial, whole] = copyLines(withCopies(facts(null, 13), { lastMessageAt: null, messages: 12, lines: 30, complete: false }))
    expect(partial).toMatchObject({ more: null, newer: false })
    expect(whole).toEqual({ label: "Archive's copy", text: 'At least 12 messages', more: null, newer: false })
    expect(copyLines(conflict as Extract<ImportAction, { kind: 'conflict' }>)).toEqual([])
  })
})

describe('the import verdict', () => {
  it('counts each session by what import will do, naming only the parts that have sessions', () => {
    const choices = new Map<SessionKey, ConflictChoice>([[key(4), 'replace']])
    expect(verdict(preview, new Set(), choices).map((part) => part.text)).toEqual([
      '1 will be added',
      '1 will be updated',
      '1 will be replaced',
      "1 differs, keeping this computer's copy",
      '1 already here',
      '1 blocked',
    ])
    choices.set(key(3), 'skip')
    expect(verdict(preview, new Set([key(1)]), choices).map((part) => part.kind)).toEqual(['update', 'replace', 'keep', 'identical', 'blocked', 'left-out'])
  })

  it('names a replace that sets aside newer messages here on its own', () => {
    const ahead: ImportAction = { ...conflict, reason: 'target-newer' }
    const risky: ImportPreview = { sessions: [{ key: key(1), action: ahead, targetCwd: null, warnings: [] }, { key: key(2), action: conflict, targetCwd: null, warnings: [] }] }
    expect(verdict(risky, new Set(), new Map([[key(1), 'replace']])).map((part) => [part.kind, part.text])).toEqual([
      ['replace-newer', '1 will replace a copy with newer messages'],
      ['keep', "1 differs, keeping this computer's copy"],
    ])
  })

  it('shows blocked as an error only when something is wrong', () => {
    expect(planBadge({ kind: 'blocked', reason: 'live', message: 'm' }, 'skip').tone).toBe('neutral')
    expect(planBadge({ kind: 'blocked', reason: 'unsafe-path', message: 'm' }, 'skip').tone).toBe('bad')
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
