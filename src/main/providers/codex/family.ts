/**
 * Codex stores each spawned subagent as its own thread whose `source` names the parent thread. Agent
 * Sessions treats a thread and every subagent below it as one session, owned by the topmost ancestor
 * whose rollout is on this machine. A subagent whose parent is missing owns its own subtree.
 */
export interface Families {
  /** The thread that owns `id`'s session. A thread that is not a subagent here owns itself. */
  rootOf(id: string): string
  /** Every thread below `root`, at any depth, in id order. Empty for a thread that owns nothing. */
  descendants(root: string): string[]
}

/** `parents` maps every local thread id to the thread that spawned it, or null. */
export function families(parents: ReadonlyMap<string, string | null>): Families {
  const rootOf = (id: string): string => {
    const chain = [id]
    for (let parent = parents.get(id); parent && parents.has(parent); parent = parents.get(parent)) {
      const loop = chain.indexOf(parent)
      // Codex never writes a cycle. If an edited store has one, its smallest id owns it, so no thread vanishes.
      if (loop >= 0) return chain.slice(loop).sort()[0]
      chain.push(parent)
    }
    return chain.at(-1)!
  }
  const byRoot = new Map<string, string[]>()
  for (const id of [...parents.keys()].sort()) {
    const root = rootOf(id)
    if (root !== id) byRoot.set(root, [...(byRoot.get(root) ?? []), id])
  }
  return { rootOf, descendants: (root) => byRoot.get(root) ?? [] }
}
