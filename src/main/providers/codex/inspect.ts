import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { ImportWarning } from '../../../shared/sessions'
import type { ManifestFile, ManifestSession } from '../../core/manifest'
import { joinStorePath, mapPath } from '../../core/paths'
import { digest } from '../../core/streams'
import type { ImportContext, ProviderEffect, RefusedAction, TargetFile, TargetInspection } from '../../core/provider'
import type { CodexEffect } from './effects'
import { hiddenFromPicker, readFacts, type RolloutFacts, type SessionMeta } from './facts'
import { isNewer, parseRolloutName, type RolloutName } from './rollout-name'
import { hasLine, INDEX_FILE, parseIndexBlob } from './session-index'
import { dbPath, readTargetRow, type Row, withSnapshot } from './state-db'
import { ARCHIVED_DIR, findRollouts, IMAGES_DIR, lockedThreadIds, type RolloutFile, SESSIONS_DIR, unzstd } from './store'
import { type RowInput, rowValues } from './thread-row'

const MAX_INDEX_ENTRY = 64 * 1024

interface ArchivedRollout {
  file: ManifestFile
  name: RolloutName
  archived: boolean
}

interface Layout {
  main: ArchivedRollout
  linked: ArchivedRollout[]
  images: { file: ManifestFile; name: string }[]
  index: ManifestFile | null
}

/** Accepts only the shapes export writes. Every target path is later built from these parsed parts, never copied. */
function layoutOf(session: ManifestSession): Layout | null {
  let main: ArchivedRollout | null = null
  const linked: ArchivedRollout[] = []
  const images: Layout['images'] = []
  let index: ManifestFile | null = null
  for (const file of session.files) {
    const segments = file.path.split('/')
    if (file.role === 'rollout' || file.role === 'linked-rollout') {
      const name = parseRolloutName(segments.at(-1)!)
      if (!name || segments.length < 2 || (segments[0] !== SESSIONS_DIR && segments[0] !== ARCHIVED_DIR)) return null
      const entry = { file, name, archived: segments[0] === ARCHIVED_DIR }
      if (file.role === 'linked-rollout') linked.push(entry)
      else if (main || name.threadId !== session.id) return null
      else main = entry
    } else if (file.role === 'generated-image') {
      const [dir, id, name, ...extra] = segments
      if (dir !== IMAGES_DIR || id !== session.id || !name || name.startsWith('.') || extra.length > 0) return null
      images.push({ file, name })
    } else if (file.role === 'index-entry') {
      if (index || file.path !== INDEX_FILE || file.size > MAX_INDEX_ENTRY) return null
      index = file
    } else {
      return null
    }
  }
  if (!main) return null
  const rolloutIds = new Set([main, ...linked].map((entry) => entry.name.rolloutId))
  return rolloutIds.size === linked.length + 1 ? { main, linked, images, index } : null
}

type Placement = { kind: 'placed'; file: TargetFile } | { kind: 'refused'; action: RefusedAction }

/**
 * Rollouts keep their file name. A copy already on this machine is updated where it is, in whichever
 * form Codex left it, so the thread never ends up with two files for one rollout id.
 */
function place(entry: ArchivedRollout, existing: readonly RolloutFile[]): Placement {
  const copies = existing.filter((file) => file.name.rolloutId === entry.name.rolloutId)
  if (copies.length > 1) {
    return { kind: 'refused', action: { kind: 'conflict', reason: 'multiple-copies', message: `This machine has ${copies.length} copies of rollout ${entry.name.rolloutId}.` } }
  }
  const base = { role: entry.file.role, sha256: entry.file.sha256, transform: entry.name.compressed ? unzstd : null, mtimeMs: entry.file.mtimeMs }
  const [copy] = copies
  if (!copy) {
    const dirs = entry.archived ? [ARCHIVED_DIR] : [SESSIONS_DIR, ...entry.name.dateDirs]
    return { kind: 'placed', file: { ...base, path: joinStorePath(...dirs, entry.name.plain) } }
  }
  const plain = joinStorePath(...copy.rel.split('/').slice(0, -1), copy.name.plain)
  if (!copy.name.compressed) return { kind: 'placed', file: { ...base, path: plain } }
  return { kind: 'placed', file: { ...base, path: plain, supersedes: { path: copy.rel, decode: unzstd } } }
}

async function firstUnreadable(reads: (() => Promise<unknown>)[]): Promise<boolean> {
  for (const read of reads) {
    if (await read().then(() => false, () => true)) return true
  }
  return false
}

async function readAll(chunks: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const chunk of chunks) parts.push(chunk)
  return Buffer.concat(parts)
}

export async function inspectCodexTarget(root: string, session: ManifestSession, context: ImportContext): Promise<TargetInspection> {
  const warnings: ImportWarning[] = []
  const refuse = (action: RefusedAction, targetCwd: string | null = null): TargetInspection => ({ kind: 'refused', targetCwd, warnings, action })
  const invalid = (message: string) => refuse({ kind: 'blocked', reason: 'invalid-session', message })

  const layout = layoutOf(session)
  if (!layout) return invalid('The archive lists files this app does not write for a Codex session.')
  const { main } = layout
  const plainBlob = (entry: ArchivedRollout) => (entry.name.compressed ? unzstd(context.readBlob(entry.file.sha256)) : context.readBlob(entry.file.sha256))
  const unreadable = await firstUnreadable(layout.linked.filter((entry) => entry.name.compressed).map((entry) => () => digest(plainBlob(entry))))
  const facts = await readFacts(plainBlob(main)).catch(() => null)
  if (!facts || unreadable) return invalid('A compressed rollout in the archive cannot be decompressed.')
  const { meta } = facts
  if (!meta || meta.id !== session.id) return invalid('The rollout does not start with this session’s metadata.')
  if (hiddenFromPicker(meta)) warnings.push({ code: 'hidden-from-picker', clientDetail: session.clientDetail })

  if (!session.cwd) return refuse({ kind: 'blocked', reason: 'unmapped-cwd', message: 'The session records no working directory.' })
  const targetCwd = mapPath(session.cwd, context.mappings, context.source.sep, context.sep)
  if (!targetCwd) return refuse({ kind: 'blocked', reason: 'unmapped-cwd', message: `No folder on this machine is chosen for ${session.cwd}.` })
  if (!(await stat(targetCwd).then((s) => s.isDirectory(), () => false))) warnings.push({ code: 'target-cwd-missing', path: targetCwd })

  const existing = await findRollouts(root)
  const archivedIds = new Set([main, ...layout.linked].map((entry) => entry.name.rolloutId))
  const newerHere = existing.find((file) => file.name.threadId === session.id && !archivedIds.has(file.name.rolloutId) && isNewer(file.name, main.name))
  if (newerHere) {
    return refuse({ kind: 'conflict', reason: 'diverged', message: `This machine has a newer rollout of the session (${newerHere.rel}) that the archive does not include.` }, targetCwd)
  }

  const files: TargetFile[] = []
  for (const entry of [main, ...layout.linked]) {
    const placed = place(entry, existing)
    if (placed.kind === 'refused') return refuse(placed.action, targetCwd)
    files.push(placed.file)
  }
  for (const { file, name } of layout.images) {
    files.push({ role: file.role, path: joinStorePath(IMAGES_DIR, session.id, name), sha256: file.sha256, transform: null, mtimeMs: file.mtimeMs })
  }

  let indexLine: string | null = null
  if (layout.index) {
    indexLine = parseIndexBlob(await readAll(context.readBlob(layout.index.sha256)), session.id)
    if (indexLine === null) return invalid(`The archive's ${INDEX_FILE} entry is not one line for this session.`)
  }

  // A linked rollout of another thread (a fork's parent) lands here too. That thread gets a row now,
  // because importing it later finds its rollout identical and skips, which would leave it unlisted.
  const others = new Map<string, { entry: ArchivedRollout; file: TargetFile }>()
  layout.linked.forEach((entry, index) => {
    const known = others.get(entry.name.threadId)
    if (entry.name.threadId !== session.id && (!known || isNewer(entry.name, known.entry.name))) others.set(entry.name.threadId, { entry, file: files[index + 1] })
  })

  const effects: CodexEffect[] = []
  const db = dbPath(root, context.env)
  const targets = await withSnapshot(db, (snapshot) => [session.id, ...others.keys()].map((id) => readTargetRow(snapshot, id)))
  if (targets?.[0]) {
    const realRoot = await realpath(root).catch(() => path.resolve(root))
    const input = (thread: { file: TargetFile; facts: RolloutFacts; meta: SessionMeta; cwd: string; title: string | null; name: string | null }): RowInput => ({
      ...thread,
      id: thread.meta.id,
      rolloutPath: path.join(realRoot, ...thread.file.path.split('/')),
      archived: thread.file.path.startsWith(`${ARCHIVED_DIR}/`),
      createdMs: Date.parse(thread.meta.timestamp ?? '') || (thread.facts.firstMs ?? Date.parse(session.createdAt)),
      updatedMs: thread.facts.lastMs ?? Date.parse(session.lastActivity),
    })
    const name = indexLine === null ? null : (JSON.parse(indexLine) as { thread_name: string }).thread_name
    effects.push(rowEffect(db, targets[0], input({ file: files[0], facts, meta, cwd: targetCwd, title: session.title, name })))
    for (const [index, { entry, file }] of [...others.values()].entries()) {
      const target = targets[index + 1]
      if (!target || target.current) continue
      const other = await readFacts(plainBlob(entry))
      if (!other.meta || other.meta.id !== entry.name.threadId) continue
      const cwd = (other.meta.cwd && mapPath(other.meta.cwd, context.mappings, context.source.sep, context.sep)) ?? targetCwd
      effects.push(rowEffect(db, target, input({ file, facts: other, meta: other.meta, cwd, title: null, name: null })))
    }
  }
  const present = indexLine === null ? null : await hasLine(root, indexLine)
  if (indexLine !== null && present !== true) effects.push({ kind: 'index-line', line: indexLine, createsFile: present === null })

  // Import may replace a linked rollout too, so a lock on any thread it writes for blocks it.
  const locked = await lockedThreadIds(root)
  const live = [main, ...layout.linked].some((entry) => locked.has(entry.name.threadId))
  return { kind: 'ready', targetCwd, warnings, live, files, effects: effects as ProviderEffect[] }
}

function rowEffect(db: string, target: { columns: Set<string>; current: Row | null }, input: RowInput): CodexEffect {
  const row = rowValues(input, target.columns, target.current !== null)
  const prior = target.current && Object.fromEntries(Object.keys(row).map((name) => [name, target.current![name] ?? null]))
  return { kind: 'thread-row', db, id: input.id, row, prior }
}
