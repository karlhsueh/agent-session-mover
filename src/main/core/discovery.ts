import path from 'node:path'
import { AGENT_IDS, type AgentId, type ScanProgress, type SessionList } from '../../shared/sessions'
import type { CoreContext } from './export'
import { type CachePass, FactsCache } from './facts-cache'
import type { FileStamp, Scan } from './provider'

/** Lists each agent's store, reusing what earlier passes learned from files that have not changed. */
export interface Discovery {
  /**
   * One agent's sessions. A call while that agent's pass runs waits for a fresh pass that starts after
   * it, since the running one may have listed its folders before a new session appeared.
   */
  list(agent: AgentId, onProgress?: (event: ScanProgress) => void): Promise<SessionList>
}

export interface DiscoveryOptions {
  /** Awaited after each file a pass reads. A test seam that slows a scan down so its progress can be seen. */
  pace?: (agent: AgentId) => Promise<void>
}

type Listener = (event: ScanProgress) => void

interface AgentState {
  cache: Promise<FactsCache> | null
  running: Promise<SessionList> | null
  next: Promise<SessionList> | null
  listeners: Set<Listener>
}

const PROGRESS_INTERVAL_MS = 100

export function createDiscovery(context: CoreContext, options: DiscoveryOptions = {}): Discovery {
  const states = Object.fromEntries(AGENT_IDS.map((agent) => [agent, { cache: null, running: null, next: null, listeners: new Set() }])) as Record<AgentId, AgentState>
  const cacheFile = (agent: AgentId) => path.join(context.appDataDir, 'discovery', `${agent}.json`)

  async function pass(agent: AgentId): Promise<SessionList> {
    const provider = context.providers[agent]
    const state = states[agent]
    state.cache ??= FactsCache.load(cacheFile(agent), provider.factsVersion)
    const cache = await state.cache
    const root = provider.storeRoot(context.env)
    const emit = (event: ScanProgress) => state.listeners.forEach((listener) => listener(event))
    const attempt = async (from: FactsCache) => {
      const run = from.pass()
      const sessions = await provider.discover(root, context.env, trackedScan(agent, root, run, emit, options.pace))
      await run.commit()
      return sessions
    }
    try {
      return { sessions: await attempt(cache), problems: [] }
    } catch (error) {
      if (cache.size > 0) {
        // Kept facts that a provider cannot use must never hide a store, so read every file once more.
        const fresh = FactsCache.empty(cacheFile(agent), provider.factsVersion)
        try {
          const sessions = await attempt(fresh)
          state.cache = Promise.resolve(fresh)
          return { sessions, problems: [] }
        } catch (retried) {
          error = retried
        }
      }
      return { sessions: [], problems: [{ agent, message: error instanceof Error ? error.message : String(error) }] }
    }
  }

  function start(agent: AgentId): Promise<SessionList> {
    const state = states[agent]
    const running = pass(agent).finally(() => {
      if (state.running === running) state.running = null
    })
    state.running = running
    return running
  }

  return {
    async list(agent, onProgress) {
      const state = states[agent]
      if (onProgress) state.listeners.add(onProgress)
      try {
        if (!state.running) return await start(agent)
        state.next ??= state.running.then(() => {
          state.next = null
          return start(agent)
        })
        return await state.next
      } finally {
        if (onProgress) state.listeners.delete(onProgress)
      }
    },
  }
}

/** Counts only files the cache cannot answer for, and reports at most every 100 ms plus once at the end. */
function trackedScan(agent: AgentId, root: string, run: CachePass, emit: Listener, pace: DiscoveryOptions['pace']): Scan {
  const toRead = new Map<string, number>()
  const read = new Set<string>()
  const progress: ScanProgress = { operation: 'scan', agent, filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0, current: null }
  let reportedAt = 0
  const report = (force: boolean) => {
    if (progress.filesTotal === 0 || (!force && Date.now() - reportedAt < PROGRESS_INTERVAL_MS)) return
    reportedAt = Date.now()
    emit({ ...progress })
  }
  const keyOf = (kind: string, file: FileStamp) => `${kind}\n${file.absPath}`
  return {
    expect(kind, files) {
      for (const file of files) if (!run.has(kind, file)) toRead.set(keyOf(kind, file), file.size)
      progress.filesTotal = toRead.size
      progress.bytesTotal = [...toRead.values()].reduce((sum, size) => sum + size, 0)
    },
    async facts(kind, file, derive) {
      const key = keyOf(kind, file)
      const counted = toRead.has(key) && !read.has(key)
      if (counted) {
        progress.current = path.relative(root, file.absPath).split(path.sep).join('/')
        report(reportedAt === 0)
      }
      const facts = await run.scan.facts(kind, file, derive)
      if (counted) {
        read.add(key)
        progress.filesDone = read.size
        progress.bytesDone += file.size
        report(progress.filesDone === progress.filesTotal)
        await pace?.(agent)
      }
      return facts
    },
  }
}

/** Every agent's sessions, newest activity first. A store that fails goes in `problems` without hiding the others. */
export async function listSessions(context: CoreContext, discovery: Discovery = createDiscovery(context)): Promise<SessionList> {
  const lists = await Promise.all(AGENT_IDS.map((agent) => discovery.list(agent)))
  const sessions = lists.flatMap((list) => list.sessions).sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
  return { sessions, problems: lists.flatMap((list) => list.problems) }
}
