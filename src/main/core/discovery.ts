import path from 'node:path'
import { AGENT_IDS, type AgentId, type SessionList } from '../../shared/sessions'
import type { CoreContext } from './export'
import { FactsCache } from './facts-cache'

/** Lists each agent's store, reusing what earlier passes learned from files that have not changed. */
export interface Discovery {
  /** One agent's sessions. A call while that agent's pass runs waits for a fresh pass that starts after it. */
  list(agent: AgentId): Promise<SessionList>
}

interface AgentState {
  cache: Promise<FactsCache> | null
  running: Promise<SessionList> | null
  next: Promise<SessionList> | null
}

export function createDiscovery(context: CoreContext): Discovery {
  const states = Object.fromEntries(AGENT_IDS.map((agent) => [agent, { cache: null, running: null, next: null }])) as Record<AgentId, AgentState>

  const cacheFile = (agent: AgentId) => path.join(context.appDataDir, 'discovery', `${agent}.json`)

  async function pass(agent: AgentId): Promise<SessionList> {
    const provider = context.providers[agent]
    const state = states[agent]
    state.cache ??= FactsCache.load(cacheFile(agent), provider.factsVersion)
    const cache = await state.cache
    const root = provider.storeRoot(context.env)
    const attempt = async (from: FactsCache) => {
      const run = from.pass()
      const sessions = await provider.discover(root, context.env, run.scan)
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
    list(agent) {
      const state = states[agent]
      if (!state.running) return start(agent)
      // The running pass may have listed the folder before a new session appeared, so callers get the next one.
      state.next ??= state.running.then(() => {
        state.next = null
        return start(agent)
      })
      return state.next
    },
  }
}

/** Every agent's sessions, newest activity first. A store that fails goes in `problems` without hiding the others. */
export async function listSessions(context: CoreContext, discovery: Discovery = createDiscovery(context)): Promise<SessionList> {
  const lists = await Promise.all(AGENT_IDS.map((agent) => discovery.list(agent)))
  const sessions = lists.flatMap((list) => list.sessions).sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
  return { sessions, problems: lists.flatMap((list) => list.problems) }
}
