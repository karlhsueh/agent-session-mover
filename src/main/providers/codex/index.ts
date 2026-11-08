import path from 'node:path'
import { type SessionInfo, type SessionSummary, type SubagentSummary, sessionKey } from '../../../shared/sessions'
import type { FileRole } from '../../core/manifest'
import { joinStorePath, type StorePath } from '../../core/paths'
import type { CollectedSession, Provider, ProviderEnv, SnapshotFile } from '../../core/provider'
import { digest, lengthToLastNewline, readRange } from '../../core/streams'
import { resumeLine } from '../text'
import { applyEffect, parseEffect, undoEffect } from './effects'
import { clientOf, hiddenFromPicker, metaOfLine, readFacts, type RolloutFacts, type SessionMeta } from './facts'
import { families } from './family'
import { inspectCodexTarget } from './inspect'
import { previewRollout } from './preview'
import { INDEX_FILE, type IndexLine, readIndex } from './session-index'
import { dbPath, readThreadSummaries, type ThreadSummary, withSnapshot } from './state-db'
import {
  byRolloutId,
  findRollouts,
  generatedImages,
  IMAGES_DIR,
  lockedThreadIds,
  newestByThread,
  readFirstLine,
  readRollout,
  retryOnFlip,
  type RolloutFile,
} from './store'

const AGENT = 'codex'

export const codexProvider: Provider = {
  agent: AGENT,

  storeRoot({ env, homeDir }) {
    const configured = env.CODEX_HOME
    return path.resolve(configured ? configured.normalize('NFC') : path.join(homeDir, '.codex'))
  },

  discover: (root, env) => retryOnFlip(() => discover(root, env)),
  collect: (root, id, env) => retryOnFlip(() => collect(root, id, env)),
  inspectTarget: inspectCodexTarget,
  transcriptRole: 'rollout',
  async findTranscript(root, id) {
    const main = newestByThread(await findRollouts(root)).get(id)
    return main ? { absPath: main.absPath, path: main.rel } : null
  },
  previewTranscript: previewRollout,
  async applyEffect(root, effect) {
    await applyEffect(root, parseEffect(effect))
  },
  async undoEffect(root, effect) {
    await undoEffect(root, parseEffect(effect))
  },
}

/** Everything one thread's export holds, read from the store as it is. */
interface StoreView {
  rollouts: RolloutFile[]
  byRollout: Map<string, RolloutFile>
  indexNames: Map<string, string>
  indexLines: Map<string, IndexLine>
  rows: Map<string, ThreadSummary>
}

async function view(root: string, env: ProviderEnv): Promise<StoreView> {
  const rollouts = await findRollouts(root)
  const index = await readIndex(root)
  const rows = (await withSnapshot(dbPath(root, env), readThreadSummaries).catch(() => null)) ?? new Map()
  return { rollouts, byRollout: byRolloutId(rollouts), indexNames: index.names, indexLines: index.lines, rows }
}

/** A thread's newest rollout and what it says. */
interface Thread {
  main: RolloutFile
  facts: RolloutFacts
}

async function discover(root: string, env: ProviderEnv): Promise<SessionSummary[]> {
  const store = await view(root, env)
  const locked = await lockedThreadIds(root)
  const threads = new Map<string, Thread>()
  for (const main of newestByThread(store.rollouts).values()) threads.set(main.name.threadId, { main, facts: await readFacts(readRollout(main)) })
  const family = families(new Map([...threads].map(([id, thread]) => [id, thread.facts.meta?.spawn?.parent ?? null])))
  const summaries: SessionSummary[] = []
  for (const [id, thread] of threads) {
    if (family.rootOf(id) !== id) continue
    const subagents = family.descendants(id).map((child) => threads.get(child)!)
    const parts = await sessionParts(root, thread, subagents, store)
    const session = info(thread.main, thread.facts, store, parts.files.map((part) => part.size))
    summaries.push({
      ...session,
      live: [thread, ...subagents].some((member) => locked.has(member.main.name.threadId)),
      archived: thread.main.archived || store.rows.get(id)?.archived === true,
      hiddenFromPicker: thread.facts.meta ? hiddenFromPicker(thread.facts.meta) : false,
      subagents: subagents.map(subagentSummary).sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? '')),
      resumeCommand: resumeLine(`codex resume ${id}`, session.cwd),
    })
  }
  return summaries
}

async function collect(root: string, id: string, env: ProviderEnv): Promise<CollectedSession> {
  const store = await view(root, env)
  const mains = newestByThread(store.rollouts)
  const main = mains.get(id)
  if (!main) throw new Error(`No Codex session ${id}`)
  const parents = new Map<string, string | null>()
  for (const [threadId, file] of mains) parents.set(threadId, metaOfLine(await readFirstLine(file))?.spawn?.parent ?? null)
  const family = families(parents)
  const owner = family.rootOf(id)
  if (owner !== id) throw new Error(`Codex session ${id} is a subagent of ${parents.get(id)}. Export session ${owner}, which includes it.`)
  const read = async (file: RolloutFile): Promise<Thread> => ({ main: file, facts: await readFacts(readRollout(file)) })
  const thread = await read(main)
  const subagents: Thread[] = []
  for (const child of family.descendants(id)) subagents.push(await read(mains.get(child)!))
  const parts = await sessionParts(root, thread, subagents, store)
  if (parts.missing.length > 0) throw new Error(`Codex session ${id} continues from rollout ${parts.missing[0]}, which is missing`)
  const files: SnapshotFile[] = []
  for (const part of parts.files) files.push(await snapshot(part))
  const { key: _key, agent: _agent, sizeBytes: _size, fileCount: _count, ...session } = info(main, thread.facts, store, files.map((file) => file.size))
  const locked = await lockedThreadIds(root)
  return { session: { agent: AGENT, ...session }, files, live: [thread, ...subagents].some((member) => locked.has(member.main.name.threadId)) }
}

function subagentSummary({ main, facts }: Thread): SubagentSummary {
  return { id: main.name.threadId, title: facts.task, role: roleOf(facts.meta), lastActivity: new Date(facts.lastMs ?? main.mtimeMs).toISOString() }
}

function roleOf(meta: SessionMeta | null): string | null {
  const path = meta?.agent.path ?? meta?.spawn?.path ?? null
  return meta?.agent.nickname ?? meta?.spawn?.nickname ?? meta?.agent.role ?? meta?.spawn?.role ?? (path?.split('/').filter(Boolean).at(-1) || null)
}

/** The thread's own parts, then each subagent's. A file two members share is listed once. */
async function sessionParts(root: string, thread: Thread, subagents: readonly Thread[], store: StoreView): Promise<{ files: Part[]; missing: string[] }> {
  const files: Part[] = []
  const missing: string[] = []
  const seen = new Set<string>()
  const members = [{ thread, role: 'rollout' as const }, ...subagents.map((sub) => ({ thread: sub, role: 'subagent-rollout' as const }))]
  for (const { thread: member, role } of members) {
    const parts = await partsOf(root, member.main, member.facts, store, role)
    missing.push(...parts.missing)
    for (const part of parts.files) {
      if (!seen.has(part.rel)) files.push(part)
      seen.add(part.rel)
    }
  }
  return { files, missing }
}

interface Part {
  role: FileRole
  rel: StorePath
  absPath: string
  start: number
  size: number
  mtimeMs: number
  /** A plain rollout may be mid-append, so its snapshot stops at the last newline. */
  appendOnly: boolean
}

/**
 * The newest rollout, every earlier rollout it continues from by `history_base`, and its images. The
 * session's own thread also brings its name entry. A subagent's is left out, since the archive holds
 * one index entry per session and only `codex resume <name>` reads it.
 */
async function partsOf(root: string, main: RolloutFile, facts: RolloutFacts, store: StoreView, role: 'rollout' | 'subagent-rollout'): Promise<{ files: Part[]; missing: string[] }> {
  const rollout = (file: RolloutFile, role: FileRole): Part => ({
    role,
    rel: file.rel,
    absPath: file.absPath,
    start: 0,
    size: file.size,
    mtimeMs: file.mtimeMs,
    appendOnly: !file.name.compressed,
  })
  const files = [rollout(main, role)]
  const missing: string[] = []
  const seen = new Set([main.name.rolloutId])
  for (let base = facts.meta?.historyBase ?? null; base && !seen.has(base); ) {
    seen.add(base)
    const prefix = store.byRollout.get(base)
    if (!prefix) {
      missing.push(base)
      break
    }
    files.push(rollout(prefix, 'linked-rollout'))
    base = metaOfLine(await readFirstLine(prefix))?.historyBase ?? null
  }
  const id = main.name.threadId
  for (const image of await generatedImages(root, id)) {
    files.push({ role: 'generated-image', rel: joinStorePath(IMAGES_DIR, id, image.name), absPath: image.absPath, start: 0, size: image.size, mtimeMs: image.mtimeMs, appendOnly: false })
  }
  const line = role === 'rollout' ? store.indexLines.get(id) : undefined
  if (line) files.push({ role: 'index-entry', rel: joinStorePath(INDEX_FILE), absPath: line.absPath, start: line.start, size: line.length, mtimeMs: line.mtimeMs, appendOnly: false })
  return { files, missing }
}

async function snapshot(part: Part): Promise<SnapshotFile> {
  const size = part.appendOnly ? await lengthToLastNewline(part.absPath, part.size) : part.size
  const { sha256 } = await digest(readRange(part.absPath, size, part.start))
  return { role: part.role, path: part.rel, absPath: part.absPath, start: part.start, size, sha256, mtimeMs: part.mtimeMs }
}

function info(main: RolloutFile, facts: RolloutFacts, store: StoreView, sizes: number[]): SessionInfo {
  const id = main.name.threadId
  const row = store.rows.get(id)
  const meta = facts.meta
  // Where the thread lives now: Codex filters its pickers by the row's cwd, and a resume elsewhere records a new one.
  const cwd = row?.cwd ?? facts.latestCwd ?? meta?.cwd ?? null
  const fallbackMs = main.mtimeMs
  const createdMs = Date.parse(meta?.timestamp ?? '') || (facts.firstMs ?? fallbackMs)
  return {
    key: sessionKey(AGENT, id),
    agent: AGENT,
    id,
    client: clientOf(meta),
    clientDetail: meta?.originator ?? '',
    // A spawned subagent's row title and first message are its parent's, copied with the inherited history.
    title: store.indexNames.get(id) ?? row?.name ?? (meta?.spawn ? facts.task : (row?.title ?? facts.firstUserMessage)),
    cwd,
    cwds: cwd && !facts.cwds.includes(cwd) ? [...facts.cwds, cwd] : facts.cwds,
    createdAt: new Date(createdMs).toISOString(),
    lastActivity: new Date(facts.lastMs ?? row?.updatedMs ?? fallbackMs).toISOString(),
    cliVersion: meta?.cliVersion ?? null,
    sizeBytes: sizes.reduce((sum, size) => sum + size, 0),
    fileCount: sizes.length,
  }
}
