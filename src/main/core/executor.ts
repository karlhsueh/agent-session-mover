import { createHash } from 'node:crypto'
import { constants, createReadStream, createWriteStream } from 'node:fs'
import { copyFile, link, lstat, mkdir, rename, rmdir, stat, unlink, utimes } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fsyncPath } from '../archive/archive'
import { Journal, type JournalHeader, type JournalStep, listJournals, readJournal, syncDir } from './journal'
import type { Sha256 } from './manifest'
import { isNotFound, resolveInside } from './paths'
import type { SessionPlan } from './planner'
import type { AgentId } from '../../shared/sessions'
import type { Provider, ProviderRegistry } from './provider'
import { sha256File } from './streams'

/** Test hook: stop after the Nth published file, either as an error (rolled back) or as a crash (journal left behind). */
export interface Fault {
  afterWrites: number
  mode: 'error' | 'crash'
}

export class SimulatedCrash extends Error {}

export class ExecutionError extends Error {
  constructor(
    message: string,
    readonly rolledBack: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

export interface ExecuteOptions {
  root: string
  provider: Provider
  key: string
  journalDir: string
  /** This run's backup folder. Replaced files keep their store-relative path under `<backupDir>/<agent>/`. */
  backupDir: string
  blobDir: string
  runId: string
  fault?: Fault
}

export async function executePlan(plan: SessionPlan, options: ExecuteOptions): Promise<{ backupDir: string | null }> {
  const { root, provider } = options
  const journal = await Journal.create(options.journalDir, `${options.runId}-${safeName(options.key)}`, {
    agent: provider.agent,
    root,
    backupDir: options.backupDir,
    key: options.key,
  })
  let backedUp = false
  let published = 0
  try {
    for (const write of plan.writes) {
      const finalPath = await resolveInside(root, write.file.path)
      await ensureDir(path.dirname(finalPath), root, journal)
      const temp = path.join(path.dirname(finalPath), `.${path.basename(finalPath)}.${options.runId}.tmp`)
      await journal.record({ kind: 'temp', path: temp })
      await stageFile(temp, write.file.transform ? write.file.transform(blob(options, write.file.sha256)) : blob(options, write.file.sha256), write.sha256)
      await utimes(temp, new Date(), new Date(write.file.mtimeMs))

      if (write.kind === 'replace') {
        const { supersedes } = write.file
        const existingRel = supersedes && !(await exists(finalPath)) ? supersedes.path : write.file.path
        const existingPath = await resolveInside(root, existingRel)
        const backupPath = path.join(options.backupDir, provider.agent, ...existingRel.split('/'))
        await mkdir(path.dirname(backupPath), { recursive: true })
        if ((await sha256File(existingPath)) !== write.existingSha256) throw new Error(`${existingRel} changed since it was compared`)
        await journal.record({ kind: 'backup', from: existingPath, to: backupPath, sha256: write.existingSha256 })
        await moveFile(existingPath, backupPath)
        backedUp = true
        if ((await sha256File(backupPath)) !== write.existingSha256) throw new Error(`${write.file.path} changed while it was backed up`)
      }

      await journal.record({ kind: 'publish', path: finalPath, sha256: write.sha256 })
      await link(temp, finalPath)
      await unlink(temp)
      await syncDir(path.dirname(finalPath))
      published += 1
      if (options.fault && published === options.fault.afterWrites) {
        if (options.fault.mode === 'crash') throw new SimulatedCrash(`Simulated crash after ${published} writes`)
        throw new Error(`Injected failure after ${published} writes`)
      }
    }
    for (const effect of plan.effects) {
      await journal.record({ kind: 'effect', effect })
      await provider.applyEffect(root, effect)
    }
    await journal.remove()
    return { backupDir: backedUp ? path.join(options.backupDir, provider.agent) : null }
  } catch (error) {
    if (error instanceof SimulatedCrash) {
      await journal.close()
      throw error
    }
    await journal.close()
    const rollback = await rollbackJournal(journal.file, () => provider)
    const message = error instanceof Error ? error.message : String(error)
    throw new ExecutionError(message, rollback.ok, { cause: error })
  }
}

function blob(options: ExecuteOptions, sha256: Sha256): AsyncIterable<Buffer> {
  return createReadStream(path.join(options.blobDir, sha256)) as AsyncIterable<Buffer>
}

async function stageFile(temp: string, content: AsyncIterable<Buffer>, expected: Sha256): Promise<void> {
  const hash = createHash('sha256')
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  await pipeline(Readable.from(content), hashing, createWriteStream(temp, { flags: 'wx' }))
  await fsyncPath(temp)
  if (hash.digest('hex') !== expected) throw new Error(`${temp} does not match the planned content`)
}

async function ensureDir(dir: string, root: string, journal: Journal): Promise<void> {
  const missing: string[] = []
  // resolveInside already proved the real path stays in the store, so a symlinked folder on the way is fine.
  for (let current = dir; ; current = path.dirname(current)) {
    const info = await stat(current).catch((error) => (isNotFound(error) ? null : Promise.reject(error)))
    if (info) {
      if (!info.isDirectory()) throw new Error(`${current} is not a directory`)
      break
    }
    missing.push(current)
    if (current === root || path.dirname(current) === current) break
  }
  for (const created of missing.reverse()) {
    await journal.record({ kind: 'mkdir', path: created })
    await mkdir(created).catch((error) => ((error as NodeJS.ErrnoException).code === 'EEXIST' ? undefined : Promise.reject(error)))
  }
}

async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await copyFile(from, to, constants.COPYFILE_EXCL)
    await fsyncPath(to)
    await unlink(from)
  }
}

async function exists(target: string): Promise<boolean> {
  return lstat(target).then(
    () => true,
    (error) => (isNotFound(error) ? false : Promise.reject(error)),
  )
}

async function undoStep(step: JournalStep, header: JournalHeader, provider: Provider): Promise<void> {
  switch (step.kind) {
    case 'temp':
      await unlink(step.path).catch((error) => (isNotFound(error) ? undefined : Promise.reject(error)))
      return
    case 'publish':
      // Only remove the file if it is the one this run wrote. A no-clobber link that failed leaves someone else's file.
      if ((await exists(step.path)) && (await sha256File(step.path)) === step.sha256) await unlink(step.path)
      return
    case 'backup':
      if (!(await exists(step.to))) return
      if (await exists(step.from)) throw new Error(`Cannot restore ${step.from} because a file is in the way. The original is at ${step.to}.`)
      await moveFile(step.to, step.from)
      return
    case 'mkdir':
      await rmdir(step.path).catch((error) => {
        const code = (error as NodeJS.ErrnoException).code
        return code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST' ? undefined : Promise.reject(error)
      })
      return
    case 'effect':
      await provider.undoEffect(header.root, step.effect)
      return
  }
}

function assertOwned(step: JournalStep, header: JournalHeader): void {
  const inside = (parent: string, child: string, allowSelf = false) => {
    const relative = path.relative(parent, child)
    if (relative === '') return allowSelf
    return !relative.startsWith('..') && !path.isAbsolute(relative)
  }
  const paths = step.kind === 'backup' ? [step.from] : step.kind === 'effect' ? [] : [step.path]
  for (const target of paths) {
    // Import creates the store root itself when the agent has never run on this machine.
    if (!inside(header.root, target, step.kind === 'mkdir')) throw new Error(`Journal step points outside the store: ${target}`)
  }
  if (step.kind === 'backup' && !inside(header.backupDir, step.to)) throw new Error(`Journal backup points outside the backup dir: ${step.to}`)
}

/** Undoes every recorded step in reverse. Idempotent. Keeps the journal when any step fails so a later run can retry. */
export async function rollbackJournal(file: string, providerFor: (agent: AgentId) => Provider): Promise<{ ok: boolean; errors: string[] }> {
  const { header, steps } = await readJournal(file)
  const errors: string[] = []
  for (const step of steps.toReversed()) {
    try {
      assertOwned(step, header)
      await undoStep(step, header, providerFor(header.agent))
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  if (errors.length === 0) await unlink(file).catch((error) => (isNotFound(error) ? undefined : Promise.reject(error)))
  return { ok: errors.length === 0, errors }
}

/** Run once at startup: any journal left behind belongs to an import that never committed. */
export async function recoverJournals(journalDir: string, providers: ProviderRegistry): Promise<{ file: string; ok: boolean; errors: string[] }[]> {
  const results = []
  for (const file of await listJournals(journalDir)) {
    try {
      results.push({ file, ...(await rollbackJournal(file, (agent) => providers[agent])) })
    } catch (error) {
      results.push({ file, ok: false, errors: [error instanceof Error ? error.message : String(error)] })
    }
  }
  return results
}

function safeName(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, '_')
}
