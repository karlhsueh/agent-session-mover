import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AGENT_IDS, type AgentId, type ScanProgress, type SessionList } from '../../shared/sessions'
import { type Listings, mergedList, NO_LISTINGS, type PendingScan, visibleScans, withAnswer } from './model/listing'


export interface Listing {
  listings: Listings
  /** Sessions from every agent that has answered. Null until the first answers. */
  list: SessionList | null
  /** Every agent has answered at least once. */
  settled: boolean
  scans: PendingScan[]
  /** A refresh of an already listed store is running. */
  refreshing: boolean
  refresh: () => void
}

/** Lists each agent's store separately, so the first agent to finish shows while the others read. */
export function useListings(): Listing {
  const [listings, setListings] = useState(NO_LISTINGS)
  const [inFlight, setInFlight] = useState<ReadonlySet<AgentId>>(new Set())
  const [progress, setProgress] = useState<Partial<Record<AgentId, ScanProgress>>>({})
  const latest = useRef<Partial<Record<AgentId, ScanProgress>>>({})
  const frame = useRef<number | null>(null)
  const calls = useRef(new Map<AgentId, number>())

  useEffect(() => {
    // Scans report up to ten times a second per agent, so events are folded into one render per frame.
    const unsubscribe = window.api.onProgress((event) => {
      if (event.operation !== 'scan') return
      latest.current = { ...latest.current, [event.agent]: event }
      frame.current ??= requestAnimationFrame(() => {
        frame.current = null
        setProgress(latest.current)
      })
    })
    return () => {
      unsubscribe()
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    }
  }, [])

  const load = useCallback(async (agent: AgentId) => {
    calls.current.set(agent, (calls.current.get(agent) ?? 0) + 1)
    setInFlight((current) => new Set(current).add(agent))
    const result = await window.api.listSessions(agent)
    setListings((current) => withAnswer(current, agent, result))
    const left = calls.current.get(agent)! - 1
    calls.current.set(agent, left)
    if (left > 0) return
    const { [agent]: _done, ...rest } = latest.current
    latest.current = rest
    setProgress(rest)
    setInFlight((current) => {
      const next = new Set(current)
      next.delete(agent)
      return next
    })
  }, [])

  const refresh = useCallback(() => {
    for (const agent of AGENT_IDS) void load(agent)
  }, [load])

  useEffect(() => refresh(), [refresh])

  const list = useMemo(() => mergedList(listings), [listings])
  const settled = AGENT_IDS.every((agent) => listings[agent] !== null)
  return { listings, list, settled, scans: visibleScans(listings, inFlight, progress), refreshing: settled && inFlight.size > 0, refresh }
}
