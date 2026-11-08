import { mkdir, open, readdir, readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { FileHandle } from 'node:fs/promises'
import { type AgentId, isAgentId } from '../../shared/sessions'
import { isSha256, type Sha256 } from './manifest'
import type { ProviderEffect } from './provider'

export interface JournalHeader {
  kind: 'header'
  version: 1
  agent: AgentId
  root: string
  backupDir: string
  key: string
}

/** Each step is recorded before the change it names, so its undo must tolerate the change never happening. */
export type JournalStep =
  | { kind: 'mkdir'; path: string }
  | { kind: 'temp'; path: string }
  | { kind: 'backup'; from: string; to: string; sha256: Sha256 }
  | { kind: 'publish'; path: string; sha256: Sha256 }
  | { kind: 'effect'; effect: ProviderEffect }

export const JOURNAL_SUFFIX = '.journal.jsonl'

export class Journal {
  private constructor(
    readonly file: string,
    private readonly handle: FileHandle,
  ) {}

  static async create(dir: string, name: string, header: Omit<JournalHeader, 'kind' | 'version'>): Promise<Journal> {
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, name + JOURNAL_SUFFIX)
    const handle = await open(file, 'wx')
    const journal = new Journal(file, handle)
    await journal.append({ kind: 'header', version: 1, ...header })
    await syncDir(dir)
    return journal
  }

  async record(step: JournalStep): Promise<void> {
    await this.append(step)
  }

  private async append(line: JournalHeader | JournalStep): Promise<void> {
    await this.handle.write(JSON.stringify(line) + '\n')
    await this.handle.sync()
  }

  async close(): Promise<void> {
    await this.handle.close()
  }

  /** The commit point for success, and the last step of a finished rollback. */
  async remove(): Promise<void> {
    await this.handle.close().catch(() => {})
    await unlink(this.file)
  }
}

export async function listJournals(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  return names.filter((name) => name.endsWith(JOURNAL_SUFFIX)).map((name) => path.join(dir, name))
}

export class JournalError extends Error {}

/** Parses a journal this app wrote. A torn final line is the crash point and is ignored. */
export async function readJournal(file: string): Promise<{ header: JournalHeader; steps: JournalStep[] }> {
  const lines = (await readFile(file, 'utf8')).split('\n').filter((line) => line !== '')
  const parsed: unknown[] = []
  for (const [index, line] of lines.entries()) {
    try {
      parsed.push(JSON.parse(line))
    } catch (error) {
      if (index === lines.length - 1) break
      throw new JournalError(`${file} line ${index + 1} is not JSON`, { cause: error })
    }
  }
  const [first, ...rest] = parsed
  const header = parseHeader(first, file)
  return { header, steps: rest.map((step, index) => parseStep(step, `${file} step ${index + 1}`)) }
}

function parseHeader(value: unknown, file: string): JournalHeader {
  const v = value as Partial<JournalHeader> | undefined
  if (
    v?.kind !== 'header' ||
    v.version !== 1 ||
    !isAgentId(v.agent) ||
    typeof v.root !== 'string' ||
    typeof v.backupDir !== 'string' ||
    typeof v.key !== 'string'
  ) {
    throw new JournalError(`${file} has no valid header`)
  }
  return v as JournalHeader
}

function parseStep(value: unknown, where: string): JournalStep {
  const v = value as Record<string, unknown> | null
  const str = (key: string) => typeof v?.[key] === 'string'
  switch (v?.kind) {
    case 'mkdir':
    case 'temp':
      if (str('path')) return v as JournalStep
      break
    case 'backup':
      if (str('from') && str('to') && isSha256(v.sha256)) return v as JournalStep
      break
    case 'publish':
      if (str('path') && isSha256(v.sha256)) return v as JournalStep
      break
    case 'effect':
      if (typeof v.effect === 'object' && v.effect !== null) return v as JournalStep
      break
  }
  throw new JournalError(`${where} is malformed`)
}

export async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Some platforms (Windows) cannot fsync a directory. The file data itself is already synced.
  }
}
