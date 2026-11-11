import { describe, expect, it } from 'vitest'
import type { Sha256 } from '../src/main/core/manifest'
import type { StorePath } from '../src/main/core/paths'
import { changesFor, type ComparedFile, type FileRelation, planSession, relate } from '../src/main/core/planner'
import type { TargetFile, TargetInspection } from '../src/main/core/provider'

const sha = (c: string) => c.repeat(64) as Sha256
const target = (name: string): TargetFile => ({ role: 'transcript', path: `projects/p/${name}` as StorePath, sha256: sha('0'), transform: null, mtimeMs: 0 })
const ready = (live = false): TargetInspection => ({ kind: 'ready', targetCwd: '/x', warnings: [], live, files: [], effects: [{ row: 1 }] })
const compared = (name: string, relation: FileRelation, existingMtimeMs: number | null = null): ComparedFile => ({ file: target(name), sha256: sha('1'), size: 10, relation, existingMtimeMs })

describe('relate', () => {
  const planned = { sha256: sha('a'), size: 10, prefixSha256: sha('p') }
  it('finds no target', () => expect(relate(planned, null)).toEqual({ kind: 'absent' }))
  it('matches identical bytes', () => expect(relate(planned, { sha256: sha('a'), size: 10, prefixSha256: null })).toEqual({ kind: 'identical' }))
  it('sees a strict prefix of the import', () =>
    expect(relate(planned, { sha256: sha('p'), size: 4, prefixSha256: null })).toEqual({ kind: 'target-is-prefix', existingSha256: sha('p') }))
  it('sees a target that continues past the import', () =>
    expect(relate(planned, { sha256: sha('z'), size: 20, prefixSha256: sha('a') })).toEqual({ kind: 'target-is-longer', existingSha256: sha('z') }))
  it('calls same-size different bytes different', () => expect(relate(planned, { sha256: sha('b'), size: 10, prefixSha256: null })).toEqual({ kind: 'different', existingSha256: sha('b') }))
  it('calls a shorter non-prefix different', () => expect(relate(planned, { sha256: sha('q'), size: 4, prefixSha256: null })).toEqual({ kind: 'different', existingSha256: sha('q') }))
})

describe('planSession', () => {
  it('creates when every file is new, carrying provider effects', () => {
    const plan = planSession(ready(), [compared('a', { kind: 'absent' }), compared('b', { kind: 'absent' })])
    expect(plan.action).toEqual({ kind: 'create' })
    expect(plan.writes.map((w) => w.kind)).toEqual(['create', 'create'])
    expect(plan.effects).toEqual([{ row: 1 }])
  })

  it('skips when every file is identical and writes nothing', () => {
    const plan = planSession(ready(), [compared('a', { kind: 'identical' })])
    expect(plan).toEqual({ action: { kind: 'skip-identical' }, writes: [], effects: [] })
  })

  it('updates a prefix with a backup and adds missing sidecars', () => {
    const plan = planSession(ready(), [compared('a', { kind: 'target-is-prefix', existingSha256: sha('e') }), compared('b', { kind: 'absent' }), compared('c', { kind: 'identical' })])
    expect(plan.action).toEqual({ kind: 'update', backup: true })
    expect(plan.writes).toMatchObject([{ kind: 'replace', existingSha256: sha('e') }, { kind: 'create' }])
  })

  it('writes nothing for a diverged file unless the user chooses replace', () => {
    const changedAt = Date.parse('2026-11-09T15:00:00.000Z')
    const plan = planSession(ready(), [
      compared('a', { kind: 'absent' }),
      compared('b', { kind: 'different', existingSha256: sha('d') }, changedAt),
      compared('c', { kind: 'identical' }, 0),
    ])
    expect(plan.action).toMatchObject({ kind: 'conflict', reason: 'diverged', hereChangedAt: '2026-11-09T15:00:00.000Z' })
    expect(plan.writes).toEqual([])
    expect(changesFor(plan, 'skip')).toMatchObject({ writes: [], effects: [] })
    const replace = changesFor(plan, 'replace')
    expect(replace.writes).toMatchObject([{ kind: 'create' }, { kind: 'replace', existingSha256: sha('d') }])
    expect(replace.effects).toEqual([{ row: 1 }])
  })

  it('calls a target that only continues past the import newer', () => {
    const plan = planSession(ready(), [compared('a', { kind: 'target-is-longer', existingSha256: sha('l') })])
    expect(plan.action).toMatchObject({ kind: 'conflict', reason: 'target-newer', hereChangedAt: null })
    expect(changesFor(plan, 'replace').writes).toMatchObject([{ kind: 'replace', existingSha256: sha('l') }])
  })

  it('ignores the choice for a plan that is not a conflict', () => {
    const plan = planSession(ready(), [compared('a', { kind: 'absent' })])
    expect(changesFor(plan, 'replace')).toBe(plan)
  })

  it('blocks a live target before looking at content', () => {
    const plan = planSession(ready(true), [compared('a', { kind: 'absent' })])
    expect(plan.action).toMatchObject({ kind: 'blocked', reason: 'live' })
    expect(plan.writes).toEqual([])
  })

  it('passes a provider refusal through', () => {
    const refused: TargetInspection = { kind: 'refused', targetCwd: null, warnings: [], action: { kind: 'blocked', reason: 'unmapped-cwd', message: 'm' } }
    expect(planSession(refused, []).action).toEqual({ kind: 'blocked', reason: 'unmapped-cwd', message: 'm' })
  })
})
