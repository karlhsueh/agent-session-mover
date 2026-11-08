const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const NAME = new RegExp(`^rollout-((\\d{4})-(\\d{2})-(\\d{2})T\\d{2}-\\d{2}-\\d{2})-(${UUID})(?:_(${UUID}))?\\.jsonl(\\.zst)?$`)
const ZST = '.zst'

/**
 * A rollout file name, `rollout-<local time>-<threadId>[_<rolloutId>].jsonl[.zst]`. A plain name's
 * rollout id is its thread id. A reverted thread adds a file with its own rollout id.
 */
export interface RolloutName {
  /** The `.jsonl` name, which Codex records even when the file on disk is compressed. */
  plain: string
  compressed: boolean
  /** `YYYY-MM-DDTHH-MM-SS` in the writer's local time. Sorts as text. */
  stamp: string
  dateDirs: [string, string, string]
  threadId: string
  rolloutId: string
}

export function parseRolloutName(name: string): RolloutName | null {
  const match = NAME.exec(name)
  if (!match) return null
  const [, stamp, year, month, day, threadId, rolloutId, zst] = match
  return {
    plain: zst ? name.slice(0, -ZST.length) : name,
    compressed: Boolean(zst),
    stamp,
    dateDirs: [year, month, day],
    threadId: threadId.toLowerCase(),
    rolloutId: (rolloutId ?? threadId).toLowerCase(),
  }
}

export function compressedName(plain: string): string {
  return plain + ZST
}

/** Codex resumes a thread from its newest file: latest name stamp, then the larger UUIDv7 rollout id. */
export function isNewer(a: RolloutName, b: RolloutName): boolean {
  return a.stamp > b.stamp || (a.stamp === b.stamp && a.rolloutId > b.rolloutId)
}
