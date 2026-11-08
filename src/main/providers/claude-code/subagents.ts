import { readFile } from 'node:fs/promises'
import type { SubagentSummary } from '../../../shared/sessions'
import { GAP, LIST_BUDGET, readWindow } from '../../core/window'
import { cleanTitle } from '../text'
import type { SidecarFile } from './store'
import { promptText } from './transcript'

const AGENT_FILE = /^agent-(.+)\.(jsonl|meta\.json)$/

/**
 * One summary per `subagents/agent-<id>.jsonl`, newest first. The title is the `description` the
 * parent gave in `agent-<id>.meta.json`, else the agent's first prompt. Unreadable or malformed
 * files leave the fields they would have filled empty.
 */
export async function readSubagents(sidecars: readonly SidecarFile[]): Promise<SubagentSummary[]> {
  const byId = new Map<string, { transcript?: SidecarFile; meta?: SidecarFile }>()
  for (const file of sidecars) {
    const match = file.folder === 'subagents' ? AGENT_FILE.exec(file.name) : null
    if (!match) continue
    const entry = byId.get(match[1]) ?? {}
    if (match[2] === 'jsonl') entry.transcript = file
    else entry.meta = file
    byId.set(match[1], entry)
  }
  const summaries: SubagentSummary[] = []
  for (const [id, { transcript, meta }] of byId) {
    if (!transcript) continue
    const { agentType, description } = await readMeta(meta)
    const facts = await readAgentTranscript(transcript, description === null)
    summaries.push({ id, title: description ?? facts.prompt, role: agentType, lastActivity: facts.lastActivity })
  }
  return summaries.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''))
}

async function readMeta(file: SidecarFile | undefined): Promise<{ agentType: string | null; description: string | null }> {
  const none = { agentType: null, description: null }
  if (!file) return none
  try {
    const value: unknown = JSON.parse(await readFile(file.absPath, 'utf8'))
    if (typeof value !== 'object' || value === null) return none
    const { agentType, description } = value as Record<string, unknown>
    return {
      agentType: typeof agentType === 'string' && agentType.trim() !== '' ? agentType.trim() : null,
      description: typeof description === 'string' ? cleanTitle(description) : null,
    }
  } catch {
    return none
  }
}

async function readAgentTranscript(file: SidecarFile, wantPrompt: boolean): Promise<{ prompt: string | null; lastActivity: string | null }> {
  let prompt: string | null = null
  let lastMs: number | null = null
  try {
    for await (const line of readWindow({ kind: 'file', absPath: file.absPath }, LIST_BUDGET)) {
      if (line === GAP) continue
      let record: unknown
      try {
        record = JSON.parse(line.toString('utf8'))
      } catch {
        continue
      }
      if (typeof record !== 'object' || record === null) continue
      const { timestamp, type, message } = record as Record<string, unknown>
      const ms = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN
      if (!Number.isNaN(ms)) lastMs = Math.max(lastMs ?? ms, ms)
      if (wantPrompt && prompt === null && type === 'user') {
        const text = promptText(message)
        if (text) prompt = cleanTitle(text)
      }
    }
  } catch {
    // A file removed or truncated mid-read still yields what was read.
  }
  return { prompt, lastActivity: lastMs === null ? null : new Date(lastMs).toISOString() }
}
