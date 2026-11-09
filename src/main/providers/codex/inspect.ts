import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { ImportWarning } from '../../../shared/sessions'
import type { ManifestFile, ManifestSession } from '../../core/manifest'
import { joinStorePath, mapPath } from '../../core/paths'
import { digest } from '../../core/streams'
import type { ImportContext, ProviderEffect, RefusedAction, TargetFile, TargetInspection } from '../../core/provider'
import type { CodexEffect } from './effects'
import { terminatedLines } from '../../core/window'
import { hiddenFromPicker, readFacts, type RolloutFacts, type SessionMeta } from './facts'
import { isNewer, parseRolloutName, type RolloutName } from './rollout-name'
import { hasLine, INDEX_FILE, parseIndexBlob, readIndexText } from './session-index'
import { readEdgeChildren } from './spawn-edges'
import { dbPath, readTargetRows, type Row, withSnapshot } from './state-db'
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
  /** The newest rollout of each subagent thread below the session's own thread. */
  subagents: ArchivedRollout[]
  linked: ArchivedRollout[]
  images: { file: ManifestFile; threadId: string; name: string }[]
  index: ManifestFile | null
}

/** Accepts only the shapes export writes. Every target path is later built from these parsed parts, never copied. */
function layoutOf(session: ManifestSession): Layout | null {
  let main: ArchivedRollout | null = null
  const subagents: ArchivedRollout[] = []
  const linked: ArchivedRollout[] = []
  const images: Layout['images'] = []
  let index: ManifestFile | null = null
  for (const file of session.files) {
    const segments = file.path.split('/')
    if (file.role === 'rollout' || file.role === 'subagent-rollout' || file.role === 'linked-rollout') {
      const name = parseRolloutName(segments.at(-1)!)
      if (!name || segments.length < 2 || (segments[0] !== SESSIONS_DIR && segments[0] !== ARCHIVED_DIR)) return null
      const entry = { file, name, archived: segments[0] === ARCHIVED_DIR }
      if (file.role === 'linked-rollout') linked.push(entry)
      else if (file.role === 'subagent-rollout') subagents.push(entry)
      else if (main || name.threadId !== session.id) return null
      else main = entry
    } else if (file.role === 'generated-image') {
      const [dir, threadId, name, ...extra] = segments
      if (dir !== IMAGES_DIR || !threadId || !name || name.startsWith('.') || extra.length > 0) return null
      images.push({ file, threadId, name })
    } else if (file.role === 'index-entry') {
      if (index || file.path !== INDEX_FILE || file.size > MAX_INDEX_ENTRY) return null
      index = file
    } else {
      return null
    }
  }
  if (!main) return null
  const threadIds = new Set([main, ...subagents].map((entry) => entry.name.threadId))
  if (threadIds.size !== subagents.length + 1 || images.some((image) => !threadIds.has(image.threadId))) return null
  const rolloutIds = new Set([main, ...subagents, ...linked].map((entry) => entry.name.rolloutId))
  return rolloutIds.size === subagents.length + linked.length + 1 ? { main, subagents, linked, images, index } : null
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
  const facts = await readFacts(terminatedLines(plainBlob(main))).catch(() => null)
  const subagentFacts = await Promise.all(layout.subagents.map((entry) => readFacts(terminatedLines(plainBlob(entry))).catch(() => null)))
  if (!facts || unreadable || subagentFacts.includes(null)) return invalid('A compressed rollout in the archive cannot be decompressed.')
  const { meta } = facts
  if (!meta || meta.id !== session.id) return invalid("The rollout does not start with this session's metadata.")
  const family = new Set([main, ...layout.subagents].map((entry) => entry.name.threadId))
  const subagents: Thread[] = []
  for (const [index, entry] of layout.subagents.entries()) {
    const sub = subagentFacts[index]!
    const spawn = sub.meta?.spawn
    if (sub.meta?.id !== entry.name.threadId || !spawn || !family.has(spawn.parent)) return invalid('A subagent rollout in the archive was not spawned within this session.')
    subagents.push({ entry, facts: sub, meta: sub.meta })
  }
  if (hiddenFromPicker(meta)) warnings.push({ code: 'hidden-from-picker', clientDetail: session.clientDetail })

  if (!session.cwd) return refuse({ kind: 'blocked', reason: 'unmapped-cwd', message: 'The session records no working directory.' })
  const mapCwd = (cwd: string | null) => cwd && mapPath(cwd, context.mappings, context.source.sep, context.sep)
  const targetCwd = mapCwd(session.cwd)
  if (!targetCwd) return refuse({ kind: 'blocked', reason: 'unmapped-cwd', message: `Choose a folder on this machine for ${session.cwd}.` })
  if (!(await stat(targetCwd).then((s) => s.isDirectory(), () => false))) warnings.push({ code: 'target-cwd-missing', path: targetCwd })

  const existing = await context.once('codex:rollouts', () => findRollouts(root))
  const rollouts = [main, ...layout.subagents, ...layout.linked]
  const archivedIds = new Set(rollouts.map((entry) => entry.name.rolloutId))
  for (const newest of [main, ...layout.subagents]) {
    const newerHere = existing.find((file) => file.name.threadId === newest.name.threadId && !archivedIds.has(file.name.rolloutId) && isNewer(file.name, newest.name))
    if (newerHere) {
      return refuse({ kind: 'conflict', reason: 'diverged', message: `This machine has a newer rollout of the session (${newerHere.rel}) that the archive does not include.` }, targetCwd)
    }
  }

  const files: TargetFile[] = []
  const placedAt = new Map<ArchivedRollout, TargetFile>()
  for (const entry of rollouts) {
    const placed = place(entry, existing)
    if (placed.kind === 'refused') return refuse(placed.action, targetCwd)
    files.push(placed.file)
    placedAt.set(entry, placed.file)
  }
  for (const { file, threadId, name } of layout.images) {
    files.push({ role: file.role, path: joinStorePath(IMAGES_DIR, threadId, name), sha256: file.sha256, transform: null, mtimeMs: file.mtimeMs })
  }

  let indexLine: string | null = null
  if (layout.index) {
    indexLine = parseIndexBlob(await readAll(context.readBlob(layout.index.sha256)), session.id)
    if (indexLine === null) return invalid(`The archive's ${INDEX_FILE} entry is not one line for this session.`)
  }

  // A linked rollout of another thread (a fork's parent) lands here too. That thread gets a row now,
  // because importing it later finds its rollout identical and skips, which would leave it unlisted.
  const others = new Map<string, ArchivedRollout>()
  for (const entry of layout.linked) {
    const known = others.get(entry.name.threadId)
    if (!family.has(entry.name.threadId) && (!known || isNewer(entry.name, known.name))) others.set(entry.name.threadId, entry)
  }

  const effects: CodexEffect[] = []
  const db = dbPath(root, context.env)
  const ids = [session.id, ...subagents.map((sub) => sub.meta.id), ...others.keys()]
  const state = await context.once('codex:db', () => withSnapshot(db, (snapshot) => ({ table: readTargetRows(snapshot), edgeChildren: readEdgeChildren(snapshot) })))
  const table = state?.table
  const target = state && {
    rows: ids.map((id) => table && { columns: table.columns, current: table.rows.get(id) ?? null }),
    edges: ids.map((id) => (state.edgeChildren === null ? null : state.edgeChildren.has(id) ? 'present' : 'absent')),
  }
  if (target?.rows[0]) {
    const realRoot = await realpath(root).catch(() => path.resolve(root))
    const write = (at: number, thread: Thread, fields: { cwd: string; title: string | null; name: string | null }) => {
      const file = placedAt.get(thread.entry)!
      const { facts: threadFacts, meta: threadMeta } = thread
      effects.push(
        rowEffect(db, target.rows[at]!, {
          ...fields,
          id: threadMeta.id,
          meta: threadMeta,
          facts: threadFacts,
          rolloutPath: path.join(realRoot, ...file.path.split('/')),
          archived: file.path.startsWith(`${ARCHIVED_DIR}/`),
          createdMs: Date.parse(threadMeta.timestamp ?? '') || (threadFacts.firstMs ?? Date.parse(session.createdAt)),
          updatedMs: threadFacts.lastMs ?? Date.parse(session.lastActivity),
        }),
      )
      if (threadMeta.spawn && target.edges[at] === 'absent') effects.push({ kind: 'spawn-edge', db, parent: threadMeta.spawn.parent, child: threadMeta.id })
    }
    const ownCwd = (thread: Thread) => mapCwd(thread.meta.cwd) ?? targetCwd
    const name = indexLine === null ? null : (JSON.parse(indexLine) as { thread_name: string }).thread_name
    write(0, { entry: main, facts, meta }, { cwd: targetCwd, title: session.title, name })
    for (const [index, sub] of subagents.entries()) write(index + 1, sub, { cwd: ownCwd(sub), title: sub.facts.task, name: null })
    for (const [index, entry] of [...others.values()].entries()) {
      const at = index + 1 + subagents.length
      if (!target.rows[at] || target.rows[at].current) continue
      const other = await readFacts(terminatedLines(plainBlob(entry)))
      if (other.meta?.id !== entry.name.threadId) continue
      const thread = { entry, facts: other, meta: other.meta }
      write(at, thread, { cwd: ownCwd(thread), title: null, name: null })
    }
  }
  const present = indexLine === null ? null : await hasLine(await context.once('codex:index', () => readIndexText(root)), indexLine)
  if (indexLine !== null && present !== true) effects.push({ kind: 'index-line', line: indexLine, createsFile: present === null })

  // Import may replace a linked rollout too, so a lock on any thread it writes for blocks it.
  const locked = await context.once('codex:locks', () => lockedThreadIds(root))
  const live = rollouts.some((entry) => locked.has(entry.name.threadId))
  return { kind: 'ready', targetCwd, warnings, live, files, effects: effects as ProviderEffect[] }
}

/** A rollout from the archive and what it says. */
interface Thread {
  entry: ArchivedRollout
  facts: RolloutFacts
  meta: SessionMeta
}

function rowEffect(db: string, target: { columns: Set<string>; current: Row | null }, input: RowInput): CodexEffect {
  const row = rowValues(input, target.columns, target.current !== null)
  const prior = target.current && Object.fromEntries(Object.keys(row).map((name) => [name, target.current![name] ?? null]))
  return { kind: 'thread-row', db, id: input.id, row, prior }
}
