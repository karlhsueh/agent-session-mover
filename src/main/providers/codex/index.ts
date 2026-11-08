import path from 'node:path'
import { type SessionInfo, type SessionSummary, sessionKey } from '../../../shared/sessions'
import type { FileRole } from '../../core/manifest'
import { joinStorePath, type StorePath } from '../../core/paths'
import type { CollectedSession, Provider, ProviderEnv, SnapshotFile } from '../../core/provider'
import { digest, lengthToLastNewline, readRange } from '../../core/streams'
import { resumeLine } from '../text'
import { applyEffect, parseEffect, undoEffect } from './effects'
import { clientOf, hiddenFromPicker, metaOfLine, readFacts, type RolloutFacts } from './facts'
import { inspectCodexTarget } from './inspect'
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

async function discover(root: string, env: ProviderEnv): Promise<SessionSummary[]> {
  const store = await view(root, env)
  const locked = await lockedThreadIds(root)
  const summaries: SessionSummary[] = []
  for (const main of newestByThread(store.rollouts).values()) {
    const facts = await readFacts(readRollout(main))
    const parts = await partsOf(root, main, facts, store)
    const id = main.name.threadId
    const session = info(main, facts, store, parts.files.map((part) => part.size))
    summaries.push({
      ...session,
      live: locked.has(id),
      archived: main.archived || store.rows.get(id)?.archived === true,
      hiddenFromPicker: facts.meta ? hiddenFromPicker(facts.meta) : false,
      resumeCommand: resumeLine(`codex resume ${id}`, session.cwd),
    })
  }
  return summaries
}

async function collect(root: string, id: string, env: ProviderEnv): Promise<CollectedSession> {
  const store = await view(root, env)
  const main = newestByThread(store.rollouts).get(id)
  if (!main) throw new Error(`No Codex session ${id}`)
  const facts = await readFacts(readRollout(main))
  const parts = await partsOf(root, main, facts, store)
  if (parts.missing.length > 0) throw new Error(`Codex session ${id} continues from rollout ${parts.missing[0]}, which is missing`)
  const files: SnapshotFile[] = []
  for (const part of parts.files) files.push(await snapshot(part))
  const { key: _key, agent: _agent, sizeBytes: _size, fileCount: _count, ...session } = info(main, facts, store, files.map((file) => file.size))
  return { session: { agent: AGENT, ...session }, files, live: (await lockedThreadIds(root)).has(id) }
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

/** The newest rollout, every earlier rollout it continues from by `history_base`, its images, and its name entry. */
async function partsOf(root: string, main: RolloutFile, facts: RolloutFacts, store: StoreView): Promise<{ files: Part[]; missing: string[] }> {
  const rollout = (file: RolloutFile, role: FileRole): Part => ({
    role,
    rel: file.rel,
    absPath: file.absPath,
    start: 0,
    size: file.size,
    mtimeMs: file.mtimeMs,
    appendOnly: !file.name.compressed,
  })
  const files = [rollout(main, 'rollout')]
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
  const line = store.indexLines.get(id)
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
    title: store.indexNames.get(id) ?? row?.name ?? row?.title ?? facts.firstUserMessage,
    cwd,
    cwds: cwd && !facts.cwds.includes(cwd) ? [...facts.cwds, cwd] : facts.cwds,
    createdAt: new Date(createdMs).toISOString(),
    lastActivity: new Date(facts.lastMs ?? row?.updatedMs ?? fallbackMs).toISOString(),
    cliVersion: meta?.cliVersion ?? null,
    sizeBytes: sizes.reduce((sum, size) => sum + size, 0),
    fileCount: sizes.length,
  }
}
