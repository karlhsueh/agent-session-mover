import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AGENT_IDS, type AgentId, type ScanProgress, type SessionList } from '../../shared/sessions'
import { type Listings, mergedList, NO_LISTINGS, type PendingScan, visibleScans, withAnswer } from './model/listing'

/** A focus within this long of the last check skips the check, so switching windows back and forth stays cheap. */
const FOCUS_CHECK_INTERVAL_MS = 2000

export type RefreshReason = 'focus' | 'user'

export interface Listing {
  listings: Listings
  /** Sessions from every agent that has answered. Null until the first answers. */
  list: SessionList | null
  /** Every agent has answered at least once. */
  settled: boolean
  scans: PendingScan[]
  /** A refresh of an already listed store is running. */
  refreshing: boolean
  refresh: (reason: RefreshReason) => void
}

/**
 * Lists each agent's store separately, so the first agent to finish shows while the others read. Main
 * reads only files that changed since its last pass, so a refresh is a cheap stat of the stores. It
 * runs when the window gains focus and when the user asks, never on a timer.
 */
export function useListings(): Listing {
  const [listings, setListings] = useState(NO_LISTINGS)
  const [inFlight, setInFlight] = useState<ReadonlySet<AgentId>>(new Set())
  const [progress, setProgress] = useState<Partial<Record<AgentId, ScanProgress>>>({})
  const latest = useRef<Partial<Record<AgentId, ScanProgress>>>({})
  const frame = useRef<number | null>(null)
  const lastCheck = useRef(0)
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

  const refresh = useCallback(
    (reason: RefreshReason) => {
      const now = Date.now()
      if (reason === 'focus' && now - lastCheck.current < FOCUS_CHECK_INTERVAL_MS) return
      lastCheck.current = now
      for (const agent of AGENT_IDS) void load(agent)
    },
    [load],
  )

  useEffect(() => {
    refresh('user')
    const onFocus = () => refresh('focus')
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const list = useMemo(() => mergedList(listings), [listings])
  const settled = AGENT_IDS.every((agent) => listings[agent] !== null)
  return { listings, list, settled, scans: visibleScans(listings, inFlight, progress), refreshing: settled && inFlight.size > 0, refresh }
}
