import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { FileStamp, Scan } from './provider'
import { LIST_BUDGET } from './window'

const FORMAT = 'agent-sessions-discovery-cache'
/** Bump when the file layout changes. A provider bumps its own `factsVersion` when what it derives changes. */
const LAYOUT_VERSION = 1

/** One file's facts: `[kind, absPath, size, mtimeMs, facts]`. */
type Entry = [kind: string, absPath: string, size: number, mtimeMs: number, facts: unknown]

interface CacheFile {
  format: typeof FORMAT
  version: number
  factsVersion: number
  /** Facts from a long file depend on how much of it was read, so a new budget invalidates them. */
  budget: { maxBytes: number; tailBytes: number }
  entries: Entry[]
}

/** A scan that reads every file, for callers that keep nothing between passes. */
export const NO_CACHE: Scan = { expect: () => undefined, facts: (_kind, _file, derive) => derive() }

const keyOf = (kind: string, absPath: string) => `${kind}\n${absPath}`

/**
 * Facts one provider derived from files, kept across listing passes and app launches. An entry is
 * used only while its file keeps the size and mtime it had when the facts were derived. A pass keeps
 * only the entries it used or made, so facts for a file that vanished drop with the next pass.
 */
export class FactsCache {
  private entries: Map<string, Entry>

  private constructor(
    private readonly file: string,
    private readonly factsVersion: number,
    entries: Entry[],
  ) {
    this.entries = new Map(entries.map((entry) => [keyOf(entry[0], entry[1]), entry]))
  }

  static empty(file: string, factsVersion: number): FactsCache {
    return new FactsCache(file, factsVersion, [])
  }

  /** A missing, unreadable, corrupt, or outdated file gives an empty cache. It is never an error. */
  static async load(file: string, factsVersion: number): Promise<FactsCache> {
    try {
      return new FactsCache(file, factsVersion, parseCache(JSON.parse(await readFile(file, 'utf8')), factsVersion))
    } catch {
      return FactsCache.empty(file, factsVersion)
    }
  }

  get size(): number {
    return this.entries.size
  }

  /** Starts a pass. Its facts replace the cache's only when it commits, so a failed pass loses nothing. */
  pass(): CachePass {
    const used = new Map<string, Entry>()
    let changed = false
    const lookup = (kind: string, file: FileStamp): Entry | undefined => {
      const key = keyOf(kind, file.absPath)
      const entry = used.get(key) ?? this.entries.get(key)
      return entry && entry[2] === file.size && entry[3] === file.mtimeMs ? entry : undefined
    }
    return {
      has: (kind, file) => lookup(kind, file) !== undefined,
      scan: {
        facts: async <T>(kind: string, file: FileStamp, derive: () => Promise<T>): Promise<T> => {
          const key = keyOf(kind, file.absPath)
          const hit = lookup(kind, file)
          if (hit) {
            used.set(key, hit)
            return hit[4] as T
          }
          const facts = await derive()
          used.set(key, [kind, file.absPath, file.size, file.mtimeMs, facts])
          changed = true
          return facts
        },
      },
      commit: async () => {
        if (!changed && used.size === this.entries.size) return
        this.entries = used
        await this.save().catch(() => undefined)
      },
    }
  }

  /** Written to a temp file and renamed into place, so a reader never sees half a cache. */
  private async save(): Promise<void> {
    const content: CacheFile = { format: FORMAT, version: LAYOUT_VERSION, factsVersion: this.factsVersion, budget: LIST_BUDGET, entries: [...this.entries.values()] }
    await mkdir(path.dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    try {
      await writeFile(temp, JSON.stringify(content))
      await rename(temp, this.file)
    } catch (error) {
      await unlink(temp).catch(() => undefined)
      throw error
    }
  }
}

export interface CachePass {
  /** True when the pass can take this file's facts from the cache without reading it. */
  has(kind: string, file: FileStamp): boolean
  scan: Pick<Scan, 'facts'>
  commit(): Promise<void>
}

function parseCache(value: unknown, factsVersion: number): Entry[] {
  const file = value as Partial<CacheFile> | null
  const current = file?.format === FORMAT && file.version === LAYOUT_VERSION && file.factsVersion === factsVersion
  const sameBudget = file?.budget?.maxBytes === LIST_BUDGET.maxBytes && file?.budget?.tailBytes === LIST_BUDGET.tailBytes
  if (!current || !sameBudget || !Array.isArray(file.entries)) return []
  return file.entries.filter(
    (entry): entry is Entry =>
      Array.isArray(entry) && entry.length === 5 && typeof entry[0] === 'string' && typeof entry[1] === 'string' && Number.isFinite(entry[2]) && Number.isFinite(entry[3]),
  )
}
